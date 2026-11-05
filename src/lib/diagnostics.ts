/**
 * iOS WebView storage diagnostic — server side (no money, owner only).
 *
 * Answers one question for docs/RISK_IOS_WEBVIEW_STORAGE.md: what survives
 * when Nimiq Pay iOS backgrounds, locks, reloads or kills Thence's webview?
 *
 * - Owner gate: THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES (comma separated),
 *   falling back to THENCE_PILOT_OWNER_NIMIQ_ADDRESSES when unset. Empty ⇒
 *   nobody (fail-closed). Signed-in non-owners get 404, like a missing page.
 * - Diagnostic cookie `thence_diag`: a random run id with the SAME
 *   attributes as the session cookie (HttpOnly, SameSite=Lax, Path=/, same
 *   Max-Age, Secure in production) so its fate mirrors the session cookie's
 *   while carrying nothing sensitive. It never authenticates anything.
 * - Session check: the real session is validated server-side; the client
 *   only ever receives `authenticated` plus a one-way 12-hex tag of the
 *   session ROW id (not the token) so a re-sign-in is distinguishable from
 *   the same session surviving. Tokens, hashes and cookies are never echoed.
 *
 * Nothing here touches transfers, swaps, payment switches or recovery data.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { canonicalKey } from "@/lib/pilot";

export const DIAG_COOKIE_NAME = "thence_diag";
export const DIAG_RUN_ID = /^[a-z0-9-]{8,64}$/;

export function diagnosticsOwners(source: Record<string, string | undefined> = process.env): string[] {
  const own = (source["THENCE_DIAGNOSTICS_OWNER_NIMIQ_ADDRESSES"] ?? "").trim();
  const raw = own !== "" ? own : (source["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"] ?? "");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(canonicalKey);
}

export function isDiagnosticsOwner(
  address: string | null | undefined,
  source: Record<string, string | undefined> = process.env,
): boolean {
  if (!address) return false;
  const owners = diagnosticsOwners(source);
  return owners.length > 0 && owners.includes(canonicalKey(address));
}

/** One-way, non-reversible tag of the session row id (never the token). */
export function sessionTag(sessionId: string): string {
  return createHash("sha256").update(`thence-diag-session:${sessionId}`).digest("hex").slice(0, 12);
}

export async function sessionCreatedAt(sessionId: string): Promise<Date | null> {
  const rows = await getDb().select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0]?.createdAt ?? null;
}

/** Read the diagnostic run id from a Cookie header (null when absent/invalid). */
export function readDiagCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === DIAG_COOKIE_NAME) {
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      return DIAG_RUN_ID.test(value) ? value : null;
    }
  }
  return null;
}

export function serializeDiagCookie(runId: string): string {
  if (!DIAG_RUN_ID.test(runId)) throw new Error("invalid diagnostic run id");
  const env = getEnv();
  const parts = [
    `${DIAG_COOKIE_NAME}=${encodeURIComponent(runId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${env.THENCE_SESSION_TTL_SECONDS}`,
    `Expires=${new Date(Date.now() + env.THENCE_SESSION_TTL_SECONDS * 1000).toUTCString()}`,
  ];
  if (env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function serializeClearedDiagCookie(): string {
  const parts = [`${DIAG_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (getEnv().NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
