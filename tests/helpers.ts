/**
 * Shared live-database test fixtures (B1/B2 suites).
 *
 * Official-compatible wallet fixtures: fresh Ed25519 keypairs signing the
 * exact prefixed payload pinned in tests/nimiq.test.ts. A real Nimiq Pay
 * signature still requires host interaction (pending).
 */
import { randomBytes } from "node:crypto";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { buildSignPayload, deriveNimiqAddress, sha256 } from "@/lib/nimiq";
import { isLiveTestingEnabled } from "./test-db";

/**
 * Live integration tests run ONLY with an explicit, production-safe
 * THENCE_TEST_DATABASE_URL (installed by vitest.setup.ts). A generic
 * DATABASE_URL never authorizes them — see tests/test-db.ts.
 */
export const LIVE = isLiveTestingEnabled(process.env);
export const RUN = randomBytes(4).toString("hex");

/* Fixture wallet: fresh Ed25519 keypair signing the official payload. */
export function fixtureWallet(): {
  publicKeyHex: string;
  address: string;
  signMessage: (message: string) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const keyObject = createPrivateKey({
    key: privateKey.export({ format: "der", type: "pkcs8" }),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyHex = rawPublic.toString("hex");
  return {
    publicKeyHex,
    address: deriveNimiqAddress(publicKeyHex),
    signMessage: (message: string) => sign(null, sha256(buildSignPayload(message)), keyObject).toString("hex"),
  };
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function patchJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function deleteJson(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "DELETE", headers });
}

export function getCookieFrom(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const pair = setCookie.split(";")[0]?.trim() ?? "";
  return pair || null;
}

export interface TestLogin {
  userId: string;
  cookie: string;
  address: string;
}

/**
 * Full wallet login against the live verify endpoint. Callers own user
 * cleanup; pass an `onUser` hook to track created ids for afterAll deletion.
 */
export async function loginAs(
  clientKey: Record<string, string>,
  onUser?: (userId: string) => void,
): Promise<TestLogin> {
  const { issueChallenge } = await import("@/lib/auth");
  const { POST: verifyRoutePOST } = await import("../app/api/session/verify/route");
  const wallet = fixtureWallet();
  const { message } = await issueChallenge();
  const res = await verifyRoutePOST(
    postJson(
      "http://localhost/api/session/verify",
      { challenge: message, publicKey: wallet.publicKeyHex, signature: wallet.signMessage(message) },
      clientKey,
    ),
  );
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]?.trim() ?? "";
  const body = (await res.json()) as { user: { id: string; nimiqAddress: string } };
  onUser?.(body.user.id);
  return { userId: body.user.id, cookie, address: body.user.nimiqAddress };
}
