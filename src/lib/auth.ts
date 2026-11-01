/**
 * Thence backend — wallet authentication + secure sessions (B1).
 *
 * Flow (no frontend in this milestone; the Mini App client calls these):
 *  1. POST /api/session/challenge        → server-bound challenge message
 *  2. User signs the message in Nimiq Pay (Nimiq Pay selects the signer;
 *     never assume listAccounts()[0] — official provider contract)
 *  3. POST /api/session/verify { challenge, publicKey, signature }
 *     → Ed25519 verification per src/lib/nimiq.ts, address derived from
 *       the VERIFIED public key, atomic one-time challenge consumption,
 *       account lookup/creation, opaque session issuance (HttpOnly cookie)
 *  4. GET /api/me                       → authenticated identity only
 *  5. POST /api/session/logout          → revocation + cookie clearing
 *
 * Security properties:
 * - Challenges: 256-bit random, server-stored, expiring, single-use via an
 *   atomic UPDATE…WHERE consumed_at IS NULL (concurrent reuse → one winner).
 * - Sessions: 256-bit opaque tokens; PostgreSQL stores only SHA-256 hashes.
 * - Identity always comes from the verified session — never from a
 *   client-supplied user_id or address.
 * - State-changing cookie endpoints enforce Origin/Referer matching.
 * - Nothing secret is ever logged (no signatures, tokens, cookies, hashes).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { authChallenges, sessions, users } from "@/db/schema";
import {
  deriveNimiqAddress,
  normalizeNimiqAddress,
  verifyNimiqSignature,
} from "@/lib/nimiq";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE_NAME = "thence_session";
const CHALLENGE_PURPOSE = "wallet authentication";
const CHALLENGE_APP = "thence";

/* ------------------------------------------------------------------ */
/* errors                                                               */
/* ------------------------------------------------------------------ */

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  /** Optional structured figures for the owner-bound response body (never
   * logged: logFundedFailure emits the static code only). */
  readonly details?: Record<string, string>;
  constructor(status: number, code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const unauthorized = (code = "UNAUTHORIZED", message = "Authentication required.") =>
  new AuthError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "Forbidden.") =>
  new AuthError(403, code, message);

/**
 * F8.9 — privacy-safe failure code for funded-path logs. Only static
 * UPPER_SNAKE codes pass through; everything else (messages, bodies,
 * cookies, URLs, provider internals) collapses to UNKNOWN. Never log
 * err.message: transport errors can embed hosts, databases or payloads.
 */
const FUNDED_LOG_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export function fundedFailureCode(err: unknown): string {
  if (err instanceof AuthError && FUNDED_LOG_CODE.test(err.code)) return err.code;
  return "UNKNOWN";
}

/**
 * One static-code line per funded-path failure (create/requote/prepare/
 * attach/authorize) so production logs show WHICH check failed without
 * exposing any request data. Call inside route catch blocks; behavior of
 * the response itself is unchanged.
 */
export function logFundedFailure(action: "create" | "requote" | "prepare" | "attach" | "authorize", err: unknown): void {
  console.warn(`thence funded ${action}: ${fundedFailureCode(err)}`);
}

/** B2 helper: resource ownership check. Throws 403 on mismatch. */
export function assertResourceOwner(resourceOwnerId: string, userId: string): void {
  if (resourceOwnerId !== userId) throw forbidden("NOT_OWNER", "Not the owner of this resource.");
}

/* ------------------------------------------------------------------ */
/* challenges                                                           */
/* ------------------------------------------------------------------ */

export interface IssuedChallenge {
  /** Exact message the wallet must sign (byte-identical server-side). */
  message: string;
  /** ISO expiry, informational for clients. */
  expiresAt: string;
}

/** Build the exact challenge message (purpose/app/nonce/expiry bound). */
export function buildChallengeMessage(nonceHex: string, expiresAt: Date): string {
  return (
    `Sign in to Thence\n\nPurpose: ${CHALLENGE_PURPOSE}\nApp: ${CHALLENGE_APP}\n` +
    `Nonce: ${nonceHex}\nExpires: ${expiresAt.toISOString()}`
  );
}

/**
 * Issue a login challenge. `expectedAddress`, when supplied, must be a valid
 * NQ address and is enforced at verify time (defense in depth); it is usually
 * omitted because Nimiq Pay selects the signer.
 */
export async function issueChallenge(expectedAddress?: string): Promise<IssuedChallenge> {
  let expected: string | null = null;
  if (expectedAddress !== undefined && expectedAddress.trim() !== "") {
    expected = normalizeNimiqAddress(expectedAddress); // throws on invalid
  }
  const env = getEnv();
  const nonceHex = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.THENCE_CHALLENGE_TTL_SECONDS * 1000);
  const message = buildChallengeMessage(nonceHex, expiresAt);
  await getDb().insert(authChallenges).values({
    nimiqAddress: expected,
    challenge: message,
    expiresAt,
  });
  return { message, expiresAt: expiresAt.toISOString() };
}

export interface VerifiedLogin {
  userId: string;
  nimiqAddress: string;
  sessionId: string;
}

/**
 * Verify a signed challenge and open a session. Exactly one concurrent
 * caller can consume a challenge (atomic UPDATE … WHERE consumed_at IS NULL).
 */
export async function verifyChallengeAndLogin(args: {
  challenge: string;
  publicKey: string;
  signature: string;
}): Promise<{ login: VerifiedLogin; sessionToken: string }> {
  const { challenge, publicKey, signature } = args;
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 2000) {
    throw new AuthError(400, "BAD_CHALLENGE", "Invalid challenge.");
  }
  const db = getDb();
  // Atomic single-use consumption: only an unconsumed, unexpired row wins.
  const consumed = await db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authChallenges.challenge, challenge),
        isNull(authChallenges.consumedAt),
        sql`${authChallenges.expiresAt} > NOW()`,
      ),
    )
    .returning({ id: authChallenges.id, nimiqAddress: authChallenges.nimiqAddress });
  const row = consumed[0];
  if (!row) {
    // Unknown, expired, or already consumed — same response (no oracle).
    throw new AuthError(401, "CHALLENGE_INVALID", "Challenge is unknown, expired, or already used.");
  }
  // Cryptographic verification against the STORED server message (never a
  // client-supplied message). Throws on malformed inputs, false on mismatch.
  let ok = false;
  try {
    ok = verifyNimiqSignature({ publicKeyHex: publicKey, signatureHex: signature, message: challenge });
  } catch {
    throw new AuthError(401, "SIGNATURE_INVALID", "Signature verification failed.");
  }
  if (!ok) throw new AuthError(401, "SIGNATURE_INVALID", "Signature verification failed.");
  // Identity comes from the VERIFIED public key — never from the client.
  const derivedAddress = deriveNimiqAddress(publicKey);
  if (row.nimiqAddress && normalizeNimiqAddress(row.nimiqAddress) !== derivedAddress) {
    throw new AuthError(401, "SIGNER_MISMATCH", "Signature does not match the expected address.");
  }
  // Account lookup or creation (case: normalized friendly form is canonical).
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.nimiqAddress, derivedAddress))
    .limit(1);
  let userId = existing[0]?.id;
  if (!userId) {
    const inserted = await db.insert(users).values({ nimiqAddress: derivedAddress }).returning({ id: users.id });
    const created = inserted[0];
    if (!created) throw new AuthError(500, "ACCOUNT_FAILED", "Could not create account.");
    userId = created.id;
  }
  const { sessionToken, sessionId } = await createSession(userId);
  return { login: { userId, nimiqAddress: derivedAddress, sessionId }, sessionToken };
}

/* ------------------------------------------------------------------ */
/* sessions                                                             */
/* ------------------------------------------------------------------ */

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

async function createSession(userId: string): Promise<{ sessionToken: string; tokenHash: string; expiresAt: Date; sessionId: string }> {
  const env = getEnv();
  const sessionToken = newSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = new Date(Date.now() + env.THENCE_SESSION_TTL_SECONDS * 1000);
  const inserted = await getDb()
    .insert(sessions)
    .values({ userId, tokenHash, expiresAt })
    .returning({ id: sessions.id });
  const created = inserted[0];
  if (!created) throw new AuthError(500, "SESSION_FAILED", "Could not create session.");
  return { sessionToken, tokenHash, expiresAt, sessionId: created.id };
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  nimiqAddress: string;
  expiresAt: Date;
}

/** Parse the session token from a Cookie header. Returns null when absent. */
export function readSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(idx + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

/** Validate a session token against stored hashes. Null when invalid. */
export async function getAuthenticatedSession(sessionToken: string | null): Promise<AuthenticatedSession | null> {
  if (!sessionToken) return null;
  const tokenHash = hashSessionToken(sessionToken);
  const rows = await getDb()
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      nimiqAddress: users.nimiqAddress,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > NOW()`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Require a valid session from request headers. Throws 401 otherwise. */
export async function requireSession(headers: Headers): Promise<AuthenticatedSession> {
  const token = readSessionToken(headers.get("cookie"));
  const session = await getAuthenticatedSession(token);
  if (!session) throw unauthorized();
  return session;
}

/** Backwards-compatible alias for B2+ call sites. */
export const getAuthenticatedUser = getAuthenticatedSession;

/** Revoke the session presented by the request. Idempotent: missing/unknown sessions still clear. */
export async function revokeSession(cookieHeader: string | null): Promise<void> {
  const token = readSessionToken(cookieHeader);
  if (!token) return;
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)));
}

/* ------------------------------------------------------------------ */
/* cookies                                                              */
/* ------------------------------------------------------------------ */

export function serializeSessionCookie(sessionToken: string, expiresAt: Date): string {
  const env = getEnv();
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${env.THENCE_SESSION_TTL_SECONDS}`,
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function serializeClearedSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (getEnv().NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/* ------------------------------------------------------------------ */
/* origin / CSRF                                                        */
/* ------------------------------------------------------------------ */

/**
 * Origin check for state-changing cookie-authenticated requests.
 * - Origin (or Referer fallback) present but not matching this host or the
 *   THENCE_ALLOWED_ORIGINS allowlist → 403.
 * - Both absent → allowed (non-browser clients carry no Origin; endpoints are
 *   additionally rate-limited). Documented tradeoff, not silent.
 */
export function assertSafeOrigin(request: Request): void {
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw forbidden("BAD_ORIGIN", "Unparsable request origin.");
  }
  const requestHost = new URL(request.url).host.toLowerCase();
  const allowed = new Set<string>([requestHost]);
  for (const entry of (getEnv().THENCE_ALLOWED_ORIGINS ?? "").split(",")) {
    const clean = entry.trim().toLowerCase();
    if (!clean) continue;
    try {
      allowed.add(new URL(clean).host.toLowerCase());
    } catch {
      allowed.add(clean);
    }
  }
  const candidate = parsed.host.toLowerCase();
  if (!allowed.has(candidate) && !allowed.has(`${parsed.protocol}//${candidate}`)) {
    throw forbidden("ORIGIN_MISMATCH", "Request origin not allowed.");
  }
}
