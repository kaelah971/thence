/**
 * R4 — the Fastspot swap id Nimiq Pay returns (`{ hash, swapId }`) is kept as
 * an untrusted diagnostic hint: validated, paired with the host hash, durable
 * across an interrupted report, never sent with a cancellation, and looked up
 * only through a bounded GET-only diagnostic that never exposes a preimage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_SWAP_ID_RE, hostSwapIdPrefix, normalizeHostSwapId } from "@/domain/host-swap-id";
import { reportHandoffResult } from "@/ui/lib/handoff-client";
import { loadHandoffRecord, saveHandoffRecord } from "@/ui/screens/send/useHandoff";
import { CONTRACT_STATUS_LIMITATION, lookupFastspotSwap, summarizeFastspotSwap } from "@/lib/fastspot-diag";
import { verifiedClientConfig } from "../scripts/db-tls";
import { emitHandoffStallAlert, setStallAlertSinkForTests, type HandoffStall } from "@/lib/handoff-stall";
import { handoffOutcomeSchema } from "@/lib/reconcile";

const HASH = "a".repeat(64);
const ID = "fs-swap-0001-abcdef";

/**
 * Raw REST response in the exact shape of the pinned SDK's `FastspotSwap`
 * (@nimiq/fastspot-api@2.0.0-beta.2 dist/types.d.ts): sell/buy arrays, fees,
 * hash, optional preimage, and `contracts: FastspotContract[]` with
 * { id, asset, amount, status: PENDING|REDEEMED, refundTarget, recipient, expiry, data }.
 * Values are synthetic.
 */
const V2_SWAP = {
  id: ID,
  status: "PENDING_DEPOSIT",
  sell: [{ asset: "NIM", amount: "7244.09383" }],
  buy: [{ asset: "BTC_LN", amount: "0.00031" }],
  fees: [{ asset: "NIM", network: "nimiq", amount: "0.0001", included: false, source: "NETWORK", type: "DEPOSIT_TRANSACTION" }],
  expiry: 1763060570.42,
  hash: "ef".repeat(32),
  contracts: [
    { id: "nim-contract-id", asset: "NIM", amount: "7244093830", status: "PENDING", refundTarget: { address: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000" }, recipient: { address: "NQ07 1111 1111 1111 1111 1111 1111 1111 1111" }, expiry: 1763233370, data: null },
    { id: "ln-contract-id", asset: "BTC_LN", amount: "31000", status: "PENDING", refundTarget: null, recipient: "lnbc310u1pfixture", expiry: 1763060570, data: null },
  ],
};

vi.mock("@/ui/lib/payment-tracker", () => ({ kickPaymentTracker: () => undefined }));

function captureBody(): { fetch: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const f = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ handoff: { transferId: "t", status: "LIGHTNING_HANDOFF", deduplicated: false } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, bodies };
}

describe("host swap id validation", () => {
  it("accepts conservative ids and rejects everything else without rewriting", () => {
    for (const ok of [ID, "572c5c65-0ca7-4930-b805-9bdda8c0120b", "A1234567"]) expect(normalizeHostSwapId(ok)).toBe(ok);
    for (const bad of ["", "short", " fs-swap-0001", "fs swap 0001", "fs/../swap01", "x".repeat(129), "-leading-dash", null, 42, { id: ID }]) {
      expect(normalizeHostSwapId(bad)).toBeNull();
    }
    expect(HOST_SWAP_ID_RE.test("a".repeat(128))).toBe(true);
    expect(hostSwapIdPrefix(ID)).toBe("fs-swap-");
  });
});

describe("handoff report body", () => {
  it("valid: sent together with the host hash", async () => {
    const { fetch, bodies } = captureBody();
    await reportHandoffResult("t", "initiated", { fetch, sourceTxHash: HASH, hostSwapId: ID });
    expect(bodies[0]).toEqual({ outcome: "initiated", sourceTxHash: HASH, hostSwapId: ID });
  });

  it("malformed, missing or unpaired ids are dropped and never fail the report", async () => {
    const { fetch, bodies } = captureBody();
    await reportHandoffResult("t", "initiated", { fetch, sourceTxHash: HASH, hostSwapId: "bad id!" });
    await reportHandoffResult("t", "initiated", { fetch, sourceTxHash: HASH });
    await reportHandoffResult("t", "unknown", { fetch, hostSwapId: ID });
    expect(bodies).toEqual([
      { outcome: "initiated", sourceTxHash: HASH },
      { outcome: "initiated", sourceTxHash: HASH },
      { outcome: "unknown" },
    ]);
  });
});

describe("interrupted handoff record", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a valid id across reload and drops a tampered one", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    const base = { transferId: "t1", ownerUserId: "u1", invoice: "lnbc1", invokedAt: new Date(0).toISOString(), outcomeReported: false, reportedOutcome: null, sourceTxHash: HASH };
    saveHandoffRecord({ ...base, hostSwapId: ID });
    expect(loadHandoffRecord("t1", "u1")?.hostSwapId).toBe(ID);
    // Another owner never sees it.
    expect(loadHandoffRecord("t1", "u2")).toBeNull();
    store.set("thence.f4.2.handoff.v1:t1", JSON.stringify({ ...base, hostSwapId: "<script>" }));
    expect(loadHandoffRecord("t1", "u1")?.hostSwapId).toBeNull();
  });
});

describe("server schema", () => {
  it("requires the hash alongside the id and refuses it on a cancellation", () => {
    expect(handoffOutcomeSchema.safeParse({ outcome: "initiated", sourceTxHash: HASH, hostSwapId: ID }).success).toBe(true);
    expect(handoffOutcomeSchema.safeParse({ outcome: "initiated", hostSwapId: ID }).success).toBe(false);
    expect(handoffOutcomeSchema.safeParse({ outcome: "initiated", sourceTxHash: HASH, hostSwapId: "bad id!" }).success).toBe(false);
    expect(handoffOutcomeSchema.safeParse({ outcome: "cancelled", hostSwapId: ID }).success).toBe(false);
  });
});

describe("read-only Fastspot diagnostic", () => {
  it("is off unless configured, and refuses bad ids before any request", async () => {
    const f = vi.fn();
    expect(await lookupFastspotSwap(ID, null)).toEqual({ ok: false, code: "NOT_CONFIGURED" });
    expect(await lookupFastspotSwap("bad id!", { baseUrl: "https://x.invalid", apiKey: "k", fetch: f as never })).toEqual({ ok: false, code: "BAD_SWAP_ID" });
    expect(f).not.toHaveBeenCalled();
  });

  it("issues exactly one GET and returns an allowlisted snapshot without the preimage", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(V2_SWAP), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await lookupFastspotSwap(ID, { baseUrl: "https://fastspot.invalid/", apiKey: "k", fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.url).toBe(`https://fastspot.invalid/swap/${ID}`);
    expect(r).toMatchObject({ ok: true, swapStatus: "PENDING_DEPOSIT", nim: { status: "PENDING" }, lightning: { status: "PENDING" }, hasPreimage: false });
  });

  it("v2 REST shape (FastspotSwap, contracts ARRAY per the pinned SDK types): NIM and Lightning statuses, nothing sensitive", () => {
    const finished = { ...V2_SWAP, status: "FINISHED", preimage: "ab".repeat(32), contracts: V2_SWAP.contracts.map((c) => ({ ...c, status: "REDEEMED" })) };
    const r = summarizeFastspotSwap(finished);
    expect(r).toEqual({
      ok: true,
      swapStatus: "FINISHED",
      nim: { status: "REDEEMED" },
      lightning: { status: "REDEEMED" },
      otherContracts: 0,
      hasPreimage: true,
      expiry: 1763060570,
      limitation: CONTRACT_STATUS_LIMITATION,
    });
    const text = JSON.stringify(r);
    for (const secret of ["abab", "NQ07", "lnbc", "nim-contract-id", "7244093830", "refund", "deadbeef"]) expect(text).not.toContain(secret);
  });

  it("v1 SDK keyed shape (swap.contracts.NIM, as Nimiq Pay reads it) and `secret` are understood too", () => {
    const keyed = { status: "waiting-for-transactions", secret: "cd".repeat(32), contracts: { NIM: { asset: "NIM", status: "funded", htlc: { address: "NQ07 SECRET" } }, BTC_LN: { asset: "BTC_LN", status: "pending" } } };
    const r = summarizeFastspotSwap(keyed);
    expect(r).toMatchObject({ ok: true, nim: { status: "funded" }, lightning: { status: "pending" }, hasPreimage: true });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("a PENDING NIM contract is never presented as funding acknowledgement", () => {
    const r = summarizeFastspotSwap(V2_SWAP);
    expect(r).toMatchObject({ nim: { status: "PENDING" }, limitation: expect.stringMatching(/does not show whether Fastspot received or accepted the NIM funding proof/) });
    expect(Object.keys(r)).not.toContain("fundingAcknowledged");
  });

  it("maps HTTP errors, timeouts and junk to bounded codes", async () => {
    const http = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await lookupFastspotSwap(ID, { baseUrl: "https://x.invalid", apiKey: "k", fetch: http })).toEqual({ ok: false, code: "HTTP_ERROR", httpStatus: 404 });
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))) as unknown as typeof fetch;
    expect(await lookupFastspotSwap(ID, { baseUrl: "https://x.invalid", apiKey: "k", fetch: hang, timeoutMs: 10 })).toEqual({ ok: false, code: "TIMEOUT" });
    expect(summarizeFastspotSwap("nope")).toEqual({ ok: false, code: "BAD_RESPONSE" });
    expect(summarizeFastspotSwap([V2_SWAP])).toEqual({ ok: false, code: "BAD_RESPONSE" });
    expect(summarizeFastspotSwap({ status: "<b>x</b>", contracts: "no" })).toMatchObject({ ok: true, swapStatus: null, nim: null, lightning: null, otherContracts: 0 });
    expect(summarizeFastspotSwap({ contracts: [{ asset: "NIM", status: "<script>" }] })).toMatchObject({ nim: { status: null } });
  });
});

describe("R3 alert linkage", () => {
  afterEach(() => setStallAlertSinkForTests(null));
  it("adds only the 8-character prefix of the host swap id", () => {
    const lines: string[] = [];
    setStallAlertSinkForTests((l) => lines.push(l));
    const stall: HandoffStall = { stalled: true, reason: "STALLED", anchorAt: new Date(0).toISOString(), stalledSince: new Date(360_000).toISOString(), alertDue: true };
    emitHandoffStallAlert({ transferId: "r4-alert-1", satoraSwapId: null, hostSwapId: ID, stall, now: 400_000 });
    expect(JSON.parse(lines[0]!.slice("thence-alert ".length))).toMatchObject({ hostSwap: "fs-swap-" });
    expect(lines[0]).not.toContain(ID);
  });
});

describe("operator script database TLS", () => {
  it("remote targets always verify the certificate and drop URL TLS overrides", () => {
    for (const url of [
      "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require",
      "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=no-verify&channel_binding=require",
      "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db",
    ]) {
      const cfg = verifiedClientConfig(url);
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
      expect(cfg.connectionString).not.toMatch(/sslmode|no-verify/);
      expect(new URL(cfg.connectionString).hostname).toBe("ep-x.eu-central-1.aws.neon.tech");
      expect(new URL(cfg.connectionString).password).toBe("p");
    }
    expect(new URL(verifiedClientConfig("postgresql://u:p@h.neon.tech/db?sslmode=require&channel_binding=require").connectionString).searchParams.get("channel_binding")).toBe("require");
  });

  it("localhost stays without TLS", () => {
    expect(verifiedClientConfig("postgresql://u:p@localhost:5432/db").ssl).toBeUndefined();
  });

  it("the diagnostics script never disables certificate verification", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["scripts/fastspot-diag.ts", "scripts/db-tls.ts"]) {
      // Comment lines are skipped: prose that names the forbidden setting is not code.
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    }
    expect(readFileSync("scripts/fastspot-diag.ts", "utf8")).not.toMatch(/probeAnchor/);
  });
});
