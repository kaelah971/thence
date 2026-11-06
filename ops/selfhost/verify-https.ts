/**
 * HTTPS verification of a Thence deployment.
 *
 *   npx tsx --tsconfig tsconfig.json ops/selfhost/verify-https.ts <base-url> [--read-only] [--expect vps|vercel]
 *
 * Full mode (staging / test DB only): signs in with a throwaway Ed25519 wallet
 * and creates a recipient + payment request.
 * --read-only (production): no sign-in, no writes beyond an anonymous sign-in
 * challenge (what any visitor's page load does). Never moves funds.
 * --expect vps|vercel: asserts which origin served the response
 * (Vercel sets x-vercel-id; the tunnel path does not).
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { buildSignPayload, deriveNimiqAddress, sha256 } from "@/lib/nimiq";

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("https://")) ?? "").replace(/\/+$/, "");
const READ_ONLY = args.includes("--read-only");
const EXPECT = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;
if (!BASE) {
  console.error("usage: verify-https.ts <https://base> [--read-only] [--expect vps|vercel]");
  process.exit(2);
}
const EVIL = "https://evil.example";
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

async function req(path: string, init: RequestInit & { origin?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.origin) headers["Origin"] = init.origin;
  if (init.cookie) headers["Cookie"] = init.cookie;
  if (init.body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  const h = await req("/api/health");
  check("HTTPS health ok, DB reachable", h.status === 200 && h.json?.status === "ok" && h.json?.db?.reachable === true, `${h.status} ${h.json?.status}`);
  if (EXPECT) {
    const servedBy = h.headers.get("x-vercel-id") ? "vercel" : "vps";
    check(`Served by ${EXPECT}`, servedBy === EXPECT, `served by ${servedBy}${h.headers.get("cf-ray") ? " (via Cloudflare)" : ""}`);
  }
  const root = await req("/");
  check("Homepage redirects to /app", [307, 308].includes(root.status) && (root.headers.get("location") ?? "").endsWith("/app"), `${root.status} ${root.headers.get("location")}`);
  const app = await req("/app");
  check("Onboarding page /app loads", app.status === 200 && app.text.includes("<html"), `${app.status}`);
  const routes = await req("/api/routes/public");
  const usdc = routes.json?.routes?.find((r: any) => r.id === "usdc-polygon");
  check("Public routes: usdc-polygon listed", routes.status === 200 && !!usdc, `${routes.status} usdc-polygon=${usdc?.status}`);

  for (const p of ["/api/me", "/api/recipients", "/api/requests", "/api/transfers", "/api/pilot/status",
    "/api/transfers/00000000-0000-4000-8000-000000000000/receipt"]) {
    const r = await req(p);
    check(`Unauthenticated ${p} -> 401`, r.status === 401, `${r.status}`);
  }
  const claim = await req("/api/transfers/00000000-0000-4000-8000-000000000000/claim-intent", { method: "POST", origin: BASE, body: "{}" });
  check("Unauthenticated recovery claim -> 401", claim.status === 401, `${claim.status}`);
  const cron = await req("/api/cron/reconcile");
  check("Reconcile endpoint locked without secret", cron.status === 401 || cron.status === 503, `${cron.status} ${cron.json?.error ?? ""}`);
  const rcEvil = await req("/api/recipients", { method: "POST", origin: EVIL, body: JSON.stringify({ displayName: "x" }) });
  check("Write from foreign origin -> 403", rcEvil.status === 403 && rcEvil.json?.error === "ORIGIN_MISMATCH", `${rcEvil.status} ${rcEvil.json?.error}`);
  const outGood = await req("/api/session/logout", { method: "POST", origin: BASE });
  check("Own origin accepted by CSRF check (sign-out, no session)", outGood.status < 300, `${outGood.status} ${outGood.json?.error ?? ""}`);

  const ch = await req("/api/session/challenge", { method: "POST", origin: BASE, body: "{}" });
  check("Sign-in challenge issued", ch.status === 201 && typeof ch.json?.challenge === "string", `${ch.status}`);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
  const sig = (m: string) => sign(null, sha256(buildSignPayload(m)), privateKey).toString("hex");
  const challenge: string = ch.json?.challenge ?? "";
  const evilVerify = await req("/api/session/verify", { method: "POST", origin: EVIL, body: JSON.stringify({ challenge, publicKey: publicKeyHex, signature: sig(challenge) }) });
  check("Sign-in from foreign origin -> 403", evilVerify.status === 403 && evilVerify.json?.error === "ORIGIN_MISMATCH", `${evilVerify.status} ${evilVerify.json?.error}`);

  if (!READ_ONLY) {
    const address = deriveNimiqAddress(publicKeyHex);
    const badSig = await req("/api/session/verify", { method: "POST", origin: BASE, body: JSON.stringify({ challenge, publicKey: publicKeyHex, signature: "00".repeat(64) }) });
    check("Sign-in with invalid signature rejected", badSig.status === 401, `${badSig.status} ${badSig.json?.error}`);
    const ch2 = await req("/api/session/challenge", { method: "POST", origin: BASE, body: "{}" });
    const c2: string = ch2.json.challenge;
    const ver = await req("/api/session/verify", { method: "POST", origin: BASE, body: JSON.stringify({ challenge: c2, publicKey: publicKeyHex, signature: sig(c2) }) });
    const setCookie = ver.headers.get("set-cookie") ?? "";
    check("Wallet sign-in succeeds", ver.status === 200 && ver.json?.user?.nimiqAddress === address, `${ver.status}`);
    check("Session cookie Secure + HttpOnly + SameSite=Lax, host-only", /Secure/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Lax/i.test(setCookie) && !/Domain=/i.test(setCookie));
    const cookie = setCookie.split(";")[0]!;
    const me = await req("/api/me", { cookie });
    check("Authenticated /api/me", me.status === 200, `${me.status}`);
    const pilot = await req("/api/pilot/status", { cookie });
    check("Payments unavailable (paused)", pilot.status === 200 && pilot.json?.payments === "paused", `${pilot.status} payments=${pilot.json?.payments}`);
    const rc = await req("/api/recipients", { method: "POST", origin: BASE, cookie, body: JSON.stringify({ displayName: "HTTPS Probe" }) });
    check("Create recipient", rc.status === 201, `${rc.status}`);
    const pr = await req("/api/requests", { method: "POST", origin: BASE, cookie, body: JSON.stringify({ recipientName: "HTTPS Probe", asset: "USDC", network: "Polygon", address: "0x000000000000000000000000000000000000dEaD", amount: "1.00" }) });
    const url: string = pr.json?.request?.url ?? "";
    check("Payment request share link is absolute https", pr.status === 201 && /^https:\/\/[^/]+\/r\//.test(url), `${pr.status} ${url.replace(/\/r\/.*/, "/r/<id>")}`);
    if (url.startsWith(BASE)) check("Public request page loads", (await req(url.slice(BASE.length))).status === 200);
    const q = await req("/api/quotes", { method: "POST", origin: BASE, cookie, body: JSON.stringify({ routeId: "usdc-polygon", targetAmountAtomic: "1000000" }) });
    check("Live quote (read-only, Lightning sats)", q.status === 200 && !!q.json?.quote, `${q.status} ${q.json?.error ?? ""}`);
    const out = await req("/api/session/logout", { method: "POST", origin: BASE, cookie });
    const after = await req("/api/me", { cookie });
    check("Sign-out revokes session", out.status < 300 && after.status === 401, `${out.status} then ${after.status}`);
  }

  let fails = 0;
  for (const [n, ok, d] of results) { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  [${d}]` : ""}`); }
  console.log(`TOTAL ${results.length - fails}/${results.length} passed${READ_ONLY ? " (read-only)" : ""}`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error("probe error:", e?.message); process.exit(2); });
