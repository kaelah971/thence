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
import { lookupFastspotSwap, summarizeFastspotSwap } from "@/lib/fastspot-diag";
import { emitHandoffStallAlert, setStallAlertSinkForTests, type HandoffStall } from "@/lib/handoff-stall";
import { handoffOutcomeSchema } from "@/lib/reconcile";

const HASH = "a".repeat(64);
const ID = "fs-swap-0001-abcdef";

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
      return new Response(JSON.stringify({ id: ID, status: "PENDING", preimage: "deadbeef".repeat(8), expiry: 1.5e9 + 0.7, contracts: [{ asset: "NIM", status: "FUNDED", htlc: { address: "NQ..." } }, { asset: "BTC_LN", status: "PENDING" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await lookupFastspotSwap(ID, { baseUrl: "https://fastspot.invalid/", apiKey: "k", fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.url).toBe(`https://fastspot.invalid/swap/${ID}`);
    expect(r).toEqual({ ok: true, swapStatus: "PENDING", hasPreimage: true, expiry: 1500000000, contracts: [{ asset: "NIM", status: "FUNDED" }, { asset: "BTC_LN", status: "PENDING" }] });
    expect(JSON.stringify(r)).not.toContain("deadbeef");
  });

  it("maps HTTP errors, timeouts and junk to bounded codes", async () => {
    const http = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await lookupFastspotSwap(ID, { baseUrl: "https://x.invalid", apiKey: "k", fetch: http })).toEqual({ ok: false, code: "HTTP_ERROR", httpStatus: 404 });
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))) as unknown as typeof fetch;
    expect(await lookupFastspotSwap(ID, { baseUrl: "https://x.invalid", apiKey: "k", fetch: hang, timeoutMs: 10 })).toEqual({ ok: false, code: "TIMEOUT" });
    expect(summarizeFastspotSwap("nope")).toEqual({ ok: false, code: "BAD_RESPONSE" });
    expect(summarizeFastspotSwap({ status: "<b>x</b>", contracts: "no" })).toMatchObject({ ok: true, swapStatus: null, contracts: [] });
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
