/**
 * F8.12 — attach recovery for a stale attempt handle (mocked I/O only).
 *
 * Production case (d3debd19): resume holds an attempt token prepared before
 * an interruption window; the server has since expired it, so attach fails
 * 410 ATTEMPT_INVALID. The run must re-prepare the SAME transfer + revision
 * ONCE for a fresh handle and retry the SAME swap — never a new transfer,
 * never a new swap — or fail boundedly without looping when recovery is
 * impossible (e.g. disarmed pilot). No provider calls here: every network
 * hop is a stubbed same-origin API response.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachAndAuthorize,
  authorizeWithReviewedPrice,
  type PreparationInput,
  type PreparationPhase,
} from "@/ui/screens/send/usePreparation";
import type { PreparationIssue, PreparationStep } from "@/ui/lib/prepare-flow";
import { classifyPreparationFailure, refreshQuoteForResume } from "@/ui/lib/prepare-flow";

interface Scripted {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

function stubFetch(script: Scripted[], log: Array<string>): void {
  const queue = [...script];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    const body = typeof init?.body === "string" ? ` ${init.body}` : "";
    log.push(`${method} ${url}${body}`.slice(0, 400));
    const next = queue.shift();
    if (!next) throw new TypeError(`unexpected call ${method} ${url}`);
    expect(method).toBe(next.method);
    expect(url).toBe(next.path);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const INPUT: PreparationInput = {
  payee: { id: null, destinationId: null, routeId: "usdc-polygon", address: "0xabc", name: "T" },
  fixed: null,
  targetAmountAtomic: "300000",
  destination: "0xabc",
  ownerUserId: "u-1",
  quoteRevisionHint: 1,
  tokenAddress: "0xtoken",
  evmChainId: 137,
};

function harness() {
  const log: Array<string> = [];
  const states: Array<PreparationPhase> = [];
  let failure: { issue: PreparationIssue; step: PreparationStep } | null = null;
  return {
    log,
    states,
    failed: () => failure,
    setState: (s: PreparationPhase) => {
      states.push(s);
    },
    fail: (issue: PreparationIssue, step: PreparationStep) => {
      failure = { issue, step };
    },
  };
}

const baseArgs = {
  tid: "t-1",
  quoteRevision: 1,
  satoraSwapId: "swap-1",
  sourceSatsHint: "393",
} as const;

describe("attach with a stale attempt handle recovers once on the same payment", () => {
  it("re-prepares the same transfer+revision and retries the same swap with the fresh handle", async () => {
    const h = harness();
    stubFetch(
      [
        { method: "POST", path: "/api/transfers/t-1/attach", status: 410, body: { error: "ATTEMPT_INVALID", message: "expired" } },
        {
          method: "POST",
          path: "/api/transfers/t-1/prepare",
          status: 200,
          body: { attempt: { id: "a-2", status: "PREPARED", quoteRevision: 1 }, attemptToken: "fresh-tok", deduplicated: false },
        },
        { method: "POST", path: "/api/transfers/t-1/attach", status: 200, body: { attachment: { satoraSwapId: "swap-1" }, transferStatus: "QUOTED", deduplicated: false } },
        {
          method: "POST",
          path: "/api/transfers/t-1/authorize-handoff",
          status: 200,
          body: { handoff: { attemptId: "a-2", invoiceBolt11: "inv-1", sourceSats: "393", authorizedAt: new Date().toISOString() } },
        },
      ],
      h.log,
    );
    await attachAndAuthorize({
      ...baseArgs,
      attemptToken: "stale-tok",
      setState: h.setState,
      fail: h.fail,
      input: INPUT,
      isAlive: () => true,
    });
    // Same swap retried, handle rotated exactly once: stale → fresh.
    expect(h.log[0]).toContain("stale-tok");
    expect(h.log[0]).toContain("swap-1");
    expect(h.log[1]).toContain("POST /api/transfers/t-1/prepare");
    expect(h.log[1]).toContain('"expectedQuoteRevision":1');
    expect(h.log[2]).toContain("fresh-tok");
    expect(h.log[2]).toContain("swap-1");
    expect(h.log[3]).toContain("fresh-tok");
    expect(h.failed()).toBeNull();
    const last = h.states[h.states.length - 1];
    expect(last?.phase).toBe("ready");
    if (last?.phase === "ready") {
      expect(last.transferId).toBe("t-1");
      expect(last.sourceSats).toBe("393");
    }
  });

  it("surfaces a refused re-prepare instead of masking it", async () => {
    const h = harness();
    stubFetch(
      [
        { method: "POST", path: "/api/transfers/t-1/attach", status: 410, body: { error: "ATTEMPT_INVALID", message: "expired" } },
        { method: "POST", path: "/api/transfers/t-1/prepare", status: 403, body: { error: "PILOT_DISABLED", message: "stopped" } },
      ],
      h.log,
    );
    await attachAndAuthorize({
      ...baseArgs,
      attemptToken: "stale-tok",
      setState: h.setState,
      fail: h.fail,
      input: INPUT,
      isAlive: () => true,
    });
    // Exactly one attach and one prepare: no retry loop, no authorize.
    // A refused re-prepare (disarmed pilot) keeps the original retryable
    // failure so Try again self-heals once gates re-arm; only a stale
    // quote is surfaced (it alone offers the unblocking refresh action).
    expect(h.log).toHaveLength(2);
    expect(h.log.some((l) => l.includes("authorize-handoff"))).toBe(false);
    const failure = h.failed();
    expect(failure?.issue.title).toBe("Checking payment — do not resend");
    expect(failure?.step).toBe("attaching");
  });

  it("leaves non-410 attach failures untouched (no re-prepare)", async () => {
    const h = harness();
    stubFetch(
      [{ method: "POST", path: "/api/transfers/t-1/attach", status: 409, body: { error: "SWAP_CONFLICT", message: "bound" } }],
      h.log,
    );
    await attachAndAuthorize({
      ...baseArgs,
      attemptToken: "stale-tok",
      setState: h.setState,
      fail: h.fail,
      input: INPUT,
      isAlive: () => true,
    });
    expect(h.log).toHaveLength(1);
    expect(h.failed()?.issue.title).toBe("Checking payment — do not resend");
  });

  it("surfaces a stale quote from the recovery re-prepare as refresh-the-price", async () => {
    // Production d3debd19: attach 410 on the expired handle, re-prepare
    // refused with QUOTE_STALE. The UI must offer refresh-the-price
    // (action requote), not the dead stale-handle message.
    const h = harness();
    stubFetch(
      [
        { method: "POST", path: "/api/transfers/t-1/attach", status: 410, body: { error: "ATTEMPT_INVALID", message: "expired" } },
        { method: "POST", path: "/api/transfers/t-1/prepare", status: 409, body: { error: "QUOTE_STALE", message: "stale" } },
      ],
      h.log,
    );
    await attachAndAuthorize({
      ...baseArgs,
      attemptToken: "stale-tok",
      setState: h.setState,
      fail: h.fail,
      input: INPUT,
      isAlive: () => true,
    });
    expect(h.log).toHaveLength(2);
    const failure = h.failed();
    expect(failure?.issue.title).toBe("That price has expired");
    expect(failure?.issue.action).toBe("requote");
    expect(failure?.step).toBe("attaching");
  });
});

describe("refreshQuoteForResume re-quotes the same transfer at its current revision", () => {
  const transferBody = (over: Record<string, unknown> = {}) => ({
    transfer: {
      id: "t-1",
      status: "QUOTED",
      statusLabel: "Ready to pay",
      routeId: "usdc-polygon",
      recipientName: "T",
      asset: "USDC",
      network: "Polygon",
      destination: "0xabc",
      targetAmountAtomic: "300000",
      recipientDestinationId: null,
      quote: { revision: 7 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    },
  });

  it("reads the revision from the transfer and re-quotes it (no new transfer)", async () => {
    const log: Array<string> = [];
    stubFetch(
      [
        { method: "GET", path: "/api/transfers/t-1", status: 200, body: transferBody() },
        { method: "POST", path: "/api/transfers/t-1/requote", status: 200, body: transferBody({ quote: { revision: 8 } }) },
      ],
      log,
    );
    const res = await refreshQuoteForResume("t-1");
    expect(res.ok).toBe(true);
    expect(log).toHaveLength(2);
    expect(log[1]).toContain('"expectedQuoteRevision":7');
    expect(log[0]).toContain("GET /api/transfers/t-1");
  });

  it("passes a missing transfer through without re-quoting", async () => {
    const log: Array<string> = [];
    stubFetch([{ method: "GET", path: "/api/transfers/t-9", status: 404, body: { error: "NOT_FOUND", message: "gone" } }], log);
    const res = await refreshQuoteForResume("t-9");
    expect(res.ok).toBe(false);
    expect(log).toHaveLength(1);
  });

  it("passes a refused re-quote through without inventing terms", async () => {
    const log: Array<string> = [];
    stubFetch(
      [
        { method: "GET", path: "/api/transfers/t-1", status: 200, body: transferBody() },
        { method: "POST", path: "/api/transfers/t-1/requote", status: 403, body: { error: "PILOT_DISABLED", message: "stopped" } },
      ],
      log,
    );
    const res = await refreshQuoteForResume("t-1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PILOT_DISABLED");
    expect(log).toHaveLength(2);
  });
});

describe("explicit refreshed-price acceptance (no silent cost increase)", () => {
  it("maps a figured reprice failure to the accept action with figures", () => {
    const issue = classifyPreparationFailure({
      kind: "conflict",
      code: "REPRICED_NEEDS_CONFIRMATION",
      details: { quotedSourceSats: "393", liveSourceSats: "411" },
    });
    expect(issue.action).toBe("accept-reprice");
    expect(issue.retryable).toBe(true);
    expect(issue.reprice).toEqual({ quotedSourceSats: "393", liveSourceSats: "411" });
  });

  it("keeps a figureless reprice failure on the safe abort path", () => {
    const issue = classifyPreparationFailure({ kind: "conflict", code: "REPRICED_NEEDS_CONFIRMATION", details: null });
    expect(issue.action).toBe("abort");
    expect(issue.retryable).toBe(false);
    expect(issue.reprice).toBeUndefined();
  });

  it("authorizes with the exact accepted figure and reaches ready", async () => {
    const h = harness();
    stubFetch(
      [
        {
          method: "POST",
          path: "/api/transfers/t-1/authorize-handoff",
          status: 200,
          body: { handoff: { attemptId: "a-1", invoiceBolt11: "inv-1", sourceSats: "411", authorizedAt: new Date().toISOString() } },
        },
      ],
      h.log,
    );
    await authorizeWithReviewedPrice({
      tid: "t-1",
      attemptToken: "tok-1",
      acceptedSourceSats: "411",
      input: INPUT,
      setState: h.setState,
      fail: h.fail,
      isAlive: () => true,
    });
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain('"acceptRepricedSourceSats":"411"');
    expect(h.failed()).toBeNull();
    const last = h.states[h.states.length - 1];
    expect(last?.phase).toBe("ready");
    if (last?.phase === "ready") {
      expect(last.transferId).toBe("t-1");
      expect(last.sourceSats).toBe("411");
    }
  });

  it("re-surfaces moved-again figures instead of authorizing past acceptance", async () => {
    const h = harness();
    stubFetch(
      [
        {
          method: "POST",
          path: "/api/transfers/t-1/authorize-handoff",
          status: 409,
          body: { error: "REPRICED_NEEDS_CONFIRMATION", message: "moved", details: { quotedSourceSats: "393", liveSourceSats: "422" } },
        },
      ],
      h.log,
    );
    await authorizeWithReviewedPrice({
      tid: "t-1",
      attemptToken: "tok-1",
      acceptedSourceSats: "411",
      input: INPUT,
      setState: h.setState,
      fail: h.fail,
      isAlive: () => true,
    });
    expect(h.log).toHaveLength(1);
    const failure = h.failed();
    expect(failure?.issue.action).toBe("accept-reprice");
    expect(failure?.issue.reprice).toEqual({ quotedSourceSats: "393", liveSourceSats: "422" });
    expect(failure?.step).toBe("authorizing");
  });

  it("carries server figures from attach-time authorize failures", async () => {
    const h = harness();
    stubFetch(
      [
        { method: "POST", path: "/api/transfers/t-1/attach", status: 200, body: { attachment: { satoraSwapId: "swap-1" }, transferStatus: "QUOTED", deduplicated: false } },
        {
          method: "POST",
          path: "/api/transfers/t-1/authorize-handoff",
          status: 409,
          body: { error: "REPRICED_NEEDS_CONFIRMATION", message: "moved", details: { quotedSourceSats: "393", liveSourceSats: "411" } },
        },
      ],
      h.log,
    );
    await attachAndAuthorize({
      ...baseArgs,
      attemptToken: "tok-1",
      setState: h.setState,
      fail: h.fail,
      input: INPUT,
      isAlive: () => true,
    });
    const failure = h.failed();
    expect(failure?.issue.action).toBe("accept-reprice");
    expect(failure?.issue.reprice).toEqual({ quotedSourceSats: "393", liveSourceSats: "411" });
    expect(failure?.step).toBe("authorizing");
  });
});
