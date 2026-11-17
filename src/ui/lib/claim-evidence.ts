/**
 * Claim submission evidence (incident f1ca0926, 2026-11-16).
 *
 * The SDK's `claim()` either returns or throws a plain Error. Thence used to
 * treat EVERY throw as "the delivery may have been sent" and showed
 * "Delivery submitted": the f1ca0926 claim threw before anything reached
 * Arbitrum (no UserOperation from any sender, no transaction, no provider
 * claim), yet the screen said it was submitted, and the error itself was
 * never rendered or persisted, so the failing step is unknown.
 *
 * What was actually sent is recorded by observing the claim's own network
 * requests:
 * - Arbitrum: a sponsored ERC-4337 UserOperation (EntryPoint v0.7, EIP-7702
 *   Kernel v3.3). Submission = `eth_sendUserOperation` answered with a
 *   UserOperation hash. A JSON-RPC error answer = explicitly NOT accepted.
 * - Polygon: Satora's gasless relay. Submission = `POST /swap/:id/claim-gasless`
 *   answered 2xx (4xx = refused, 5xx/no answer = unknown).
 *
 * Capture (verified against the installed SDK, lendaswap-sdk-pure 2.7.0):
 * viem's http transport resolves the global `fetch` per request, BUT the
 * SDK's Satora API client (openapi-fetch) captures `globalThis.fetch` once,
 * when the client is built, and passes a `Request` object. A wrapper that is
 * installed only around `claim()` therefore misses the swap refresh and the
 * DEX-calldata request. `installClaimFetchObserver()` must run BEFORE the SDK
 * client is built (satora-browser.ts loadClient); it is a pass-through
 * unless a claim is being observed.
 *
 * Classification uses WHICH REQUEST failed, never the error text alone: the
 * SDK's errors embed the full JSON-RPC request body (including the claim
 * calldata, which carries the preimage) and every UserOperation dump mentions
 * "paymaster", so text matching misclassifies and is unsafe to forward.
 *
 * Calldata-bearing requests made before submission (gas estimation,
 * sponsorship) are recorded as `disclosedToInfrastructure`: an honest fact,
 * not a submission. Nothing here keeps request bodies; only method names,
 * HTTP/JSON-RPC status codes and public hashes.
 */

export type ClaimSubmission = "submitted" | "not-submitted" | "unknown";

export interface ClaimRequestFailure {
  /** Step name, e.g. "eth_estimateUserOperationGas" or "satora:POST /dex-calldata/fund". */
  step: string;
  kind: "rpc-error" | "http" | "network";
  rpcCode: number | null;
  httpStatus: number | null;
  /** Provider's own short error text, hex-redacted and bounded. */
  message: string | null;
}

export interface ClaimNetworkEvidence {
  disclosedToInfrastructure: boolean;
  sendAttempted: boolean;
  sendAccepted: boolean;
  sendRejected: boolean;
  unansweredSends: number;
  userOpHash: string | null;
  txHash: string | null;
  /** eth_getUserOperationReceipt `success`, when a receipt was seen. */
  receiptSuccess: boolean | null;
  /** Steps observed, in order (names only). */
  methods: string[];
  /** First request that failed (the SDK stops at its first error). */
  failure: ClaimRequestFailure | null;
}

export interface ClaimClassification {
  submission: ClaimSubmission;
  /** Stable, secret-free code for the audit log and the owner's message. */
  code: ClaimOutcomeCode;
  disclosedToInfrastructure: boolean;
  userOpHash: string | null;
  txHash: string | null;
  /** Last step attempted (diagnostics). */
  stage?: string | null;
  failure?: ClaimRequestFailure | null;
}

export type ClaimOutcomeCode =
  | "SUBMITTED"
  | "CONFIRMED"
  | "USEROP_REVERTED"
  | "RECEIPT_TIMEOUT"
  | "SEND_NO_ANSWER"
  | "SEND_REJECTED"
  | "AA_CONFIG_MISSING"
  | "AA_SPONSORSHIP_REJECTED"
  | "AA_ESTIMATE_FAILED"
  | "AA_UNREACHABLE"
  | "RATE_LIMITED"
  | "PROVIDER_READ_FAILED"
  | "DEX_CALLDATA_FAILED"
  | "RECOVERY_MATERIAL_MISSING"
  | "SDK_ERROR";

/** Methods whose params carry the claim calldata (preimage) to the infrastructure. */
const CALLDATA_METHODS = new Set(["eth_estimateUserOperationGas", "pm_getPaymasterStubData", "pm_getPaymasterData", "alchemy_requestGasAndPaymasterAndData", "eth_sendUserOperation"]);
const SPONSOR_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData", "alchemy_requestGasAndPaymasterAndData"]);
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const GASLESS_RE = /\/swap\/[^/?#]+\/claim-gasless(?:[?#].*)?$/;
const SATORA_HOST_RE = /^https:\/\/api\.satora\.io\//;

export function emptyEvidence(): ClaimNetworkEvidence {
  return { disclosedToInfrastructure: false, sendAttempted: false, sendAccepted: false, sendRejected: false, unansweredSends: 0, userOpHash: null, txHash: null, receiptSuccess: null, methods: [], failure: null };
}

/** Secret-free, bounded text: hex runs (calldata, signatures, preimages) are removed. */
export function sanitizeClaimError(error: unknown): string {
  return error == null || error === "" ? "" : "Delivery service error. See the recorded stage and error code.";
}

type RpcBody = { method?: unknown; id?: unknown };
type RpcReply = { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } | null };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asArray<T>(value: T | T[] | null): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface NotedRequest {
  rpc: Array<{ method: string; id: unknown }>;
  gasless: boolean;
  satoraStep: string | null;
}

function fail(ev: ClaimNetworkEvidence, f: ClaimRequestFailure): void {
  if (!ev.failure) ev.failure = f;
}

function noteRequest(ev: ClaimNetworkEvidence, url: string, method: string, body: string | null): NotedRequest {
  if (SATORA_HOST_RE.test(url)) {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    const gasless = method === "POST" && GASLESS_RE.test(path);
    const step = gasless ? "satora:POST /swap/:id/claim-gasless" : `satora:${method} ${path.replace(/\/swap\/[^/]+/, "/swap/:id")}`;
    ev.methods.push(step);
    if (gasless) {
      ev.disclosedToInfrastructure = true;
      ev.sendAttempted = true;
      ev.unansweredSends += 1;
    }
    return { rpc: [], gasless, satoraStep: step };
  }
  const parsed = body !== null ? (parseJson(body) as RpcBody | RpcBody[] | null) : null;
  const rpc: Array<{ method: string; id: unknown }> = [];
  for (const item of asArray(parsed)) {
    if (item && typeof item.method === "string") {
      rpc.push({ method: item.method, id: item.id });
      ev.methods.push(item.method);
      if (CALLDATA_METHODS.has(item.method)) ev.disclosedToInfrastructure = true;
      if (item.method === "eth_sendUserOperation") {
        ev.sendAttempted = true;
        ev.unansweredSends += 1;
      }
    }
  }
  return { rpc, gasless: false, satoraStep: null };
}

function noteResponse(ev: ClaimNetworkEvidence, req: NotedRequest, status: number, text: string): void {
  const parsed = parseJson(text);
  if (req.satoraStep !== null) {
    if (req.gasless) {
      if (status >= 200 && status < 300) {
        ev.sendAccepted = true;
        ev.unansweredSends -= 1;
        const tx = (parsed as { tx_hash?: unknown } | null)?.tx_hash;
        if (typeof tx === "string" && HASH_RE.test(tx)) ev.txHash = tx;
        return;
      }
      // 4xx is a definitive refusal; 5xx may hide an accepted submission.
      if (status >= 400 && status < 500) {
        ev.sendRejected = true;
        ev.unansweredSends -= 1;
      }
    }
    if (status < 200 || status >= 300) fail(ev, { step: req.satoraStep, kind: "http", rpcCode: null, httpStatus: status, message: null });
    return;
  }
  if (status < 200 || status >= 300) {
    for (const r of req.rpc) fail(ev, { step: r.method, kind: "http", rpcCode: null, httpStatus: status, message: null });
    return;
  }
  const replies = asArray(parsed as RpcReply | RpcReply[] | null);
  for (const r of req.rpc) {
    const reply = replies.find((x) => x && x.id === r.id);
    if (!reply) continue;
    if (reply.error !== undefined && reply.error !== null) {
      const code = typeof reply.error.code === "number" ? reply.error.code : null;
      fail(ev, { step: r.method, kind: "rpc-error", rpcCode: code, httpStatus: null, message: null });
      if (r.method === "eth_sendUserOperation") {
        ev.sendRejected = true;
        ev.unansweredSends -= 1;
      }
      continue;
    }
    if (r.method === "eth_sendUserOperation" && typeof reply.result === "string" && HASH_RE.test(reply.result)) {
      ev.sendAccepted = true;
      ev.unansweredSends -= 1;
      ev.userOpHash = reply.result;
    }
    if (r.method === "eth_getUserOperationReceipt" && reply.result && typeof reply.result === "object") {
      const res = reply.result as { success?: unknown; receipt?: { transactionHash?: unknown } };
      if (typeof res.success === "boolean") ev.receiptSuccess = res.success;
      const tx = res.receipt?.transactionHash;
      if (typeof tx === "string" && HASH_RE.test(tx)) ev.txHash = tx;
    }
  }
}

type FetchLike = (input: unknown, init?: { method?: string; body?: unknown }) => Promise<Response>;
type Scope = { fetch: FetchLike };

function describe(input: unknown, init?: { method?: string; body?: unknown }): { url: string; method: string; body: () => Promise<string | null> } {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = isRequest ? (input as Request).url : input instanceof URL ? input.toString() : typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? "");
  const method = String(init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  return {
    url,
    method,
    body: async () => {
      if (typeof init?.body === "string") return init.body;
      if (isRequest) {
        try {
          return await (input as Request).clone().text();
        } catch {
          return null;
        }
      }
      return null;
    },
  };
}

/** The evidence of the claim currently being observed (null = pass-through). */
let active: { ev: ClaimNetworkEvidence; pending: Promise<void>[] } | null = null;
const INSTALLED = Symbol.for("thence.claimFetchObserver");

function wrap(original: FetchLike, scope: Scope): FetchLike {
  const observed: FetchLike = async (input, init) => {
    const rec = active;
    if (!rec) return original.call(scope, input, init);
    const d = describe(input, init);
    const req = noteRequest(rec.ev, d.url, d.method, await d.body());
    const relevant = req.gasless || req.satoraStep !== null || req.rpc.length > 0;
    let response: Response;
    try {
      response = await original.call(scope, input, init);
    } catch (error) {
      if (relevant) {
        const step = req.satoraStep ?? req.rpc[0]?.method ?? "fetch";
        fail(rec.ev, { step, kind: "network", rpcCode: null, httpStatus: null, message: null });
      }
      throw error;
    }
    if (relevant) {
      rec.pending.push(
        response
          .clone()
          .text()
          .then((text) => noteResponse(rec.ev, req, response.status, text))
          .catch(() => undefined),
      );
    }
    return response;
  };
  (observed as unknown as Record<symbol, boolean>)[INSTALLED] = true;
  return observed;
}

/**
 * Install the persistent, pass-through observer on `scope.fetch`. Call it
 * BEFORE the SDK client is built (its API client captures fetch at build
 * time). Idempotent.
 */
export function installClaimFetchObserver(scope: Scope = globalThis as unknown as Scope): void {
  const current = scope.fetch as unknown as Record<symbol, boolean>;
  if (current && current[INSTALLED]) return;
  scope.fetch = wrap(scope.fetch, scope);
}

/**
 * Run `fn` while recording every request it makes through the observer.
 * If the persistent observer is not installed on `scope`, a temporary one is
 * installed for the call and removed afterwards (tests, legacy callers).
 */
export async function observeClaimNetwork<T>(
  fn: () => Promise<T>,
  scope: Scope = globalThis as unknown as Scope,
): Promise<{ ok: true; value: T; evidence: ClaimNetworkEvidence } | { ok: false; error: unknown; evidence: ClaimNetworkEvidence }> {
  if (active !== null) return { ok: false, error: new Error("Another claim is being observed. No second claim was started."), evidence: emptyEvidence() };
  const rec = { ev: emptyEvidence(), pending: [] as Promise<void>[] };
  const temporary = !(scope.fetch as unknown as Record<symbol, boolean>)[INSTALLED];
  const original = scope.fetch;
  if (temporary) scope.fetch = wrap(original, scope);
  const previous = active;
  active = rec;
  try {
    const value = await fn();
    await Promise.all(rec.pending);
    return { ok: true, value, evidence: rec.ev };
  } catch (error) {
    await Promise.all(rec.pending);
    return { ok: false, error, evidence: rec.ev };
  } finally {
    active = previous;
    if (temporary) scope.fetch = original;
  }
}

/** Local exceptions (no failing request observed): what the SDK refused to do. */
function codeFromLocalError(error: unknown): ClaimOutcomeCode {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/requires AA config|aa\.bundlerUrl is required/i.test(msg)) return "AA_CONFIG_MISSING";
  if (/not found in local storage|storage is not configured|no target address|Cannot retrieve preimage/i.test(msg)) return "RECOVERY_MATERIAL_MISSING";
  return "SDK_ERROR";
}

/** Pre-submission failure code from WHICH request failed. */
function codeFromFailure(f: ClaimRequestFailure): ClaimOutcomeCode {
  if (f.httpStatus === 429 || f.rpcCode === 429 || f.rpcCode === -32005) return "RATE_LIMITED";
  if (f.step.startsWith("satora:")) return f.step.includes("/dex-calldata/") ? "DEX_CALLDATA_FAILED" : "PROVIDER_READ_FAILED";
  if (f.kind === "network" || f.kind === "http") return "AA_UNREACHABLE";
  if (SPONSOR_METHODS.has(f.step)) return "AA_SPONSORSHIP_REJECTED";
  if (f.step === "eth_estimateUserOperationGas") return "AA_ESTIMATE_FAILED";
  return "AA_UNREACHABLE";
}

/**
 * Pure: what the evidence proves.
 * - submitted: the infrastructure accepted the claim (UserOperation hash or
 *   relay 2xx) or the SDK returned success with a transaction id;
 * - unknown: a submission request was sent without a definitive answer;
 * - not-submitted: no submission was sent, or it was explicitly refused.
 */
export function classifyClaim(input: { evidence: ClaimNetworkEvidence; error?: unknown; sdkSuccess?: boolean; sdkTxHash?: string | null }): ClaimClassification {
  const ev = input.evidence;
  const txHash = ev.txHash ?? (input.sdkTxHash && HASH_RE.test(input.sdkTxHash) ? input.sdkTxHash : null);
  const stage = ev.methods.length ? ev.methods[ev.methods.length - 1] ?? null : null;
  const base = { disclosedToInfrastructure: ev.disclosedToInfrastructure, userOpHash: ev.userOpHash, txHash, stage, failure: ev.failure };
  if (ev.sendAccepted || (input.sdkSuccess === true && txHash !== null)) {
    // Accepted, then something failed: the operation exists; the chain decides.
    if (ev.receiptSuccess === false) return { ...base, submission: "submitted", code: "USEROP_REVERTED" };
    if (ev.receiptSuccess === true) return { ...base, submission: "submitted", code: "CONFIRMED" };
    if (input.error === undefined) return { ...base, submission: "submitted", code: "SUBMITTED" };
    const msg = input.error instanceof Error ? input.error.message : String(input.error);
    return { ...base, submission: "submitted", code: /reverted on-chain/i.test(msg) ? "USEROP_REVERTED" : "RECEIPT_TIMEOUT" };
  }
  if (ev.unansweredSends > 0 || input.sdkSuccess === true) return { ...base, submission: "unknown", code: "SEND_NO_ANSWER" };
  if (ev.sendRejected) return { ...base, submission: "not-submitted", code: "SEND_REJECTED" };
  if (ev.sendAttempted) return { ...base, submission: "unknown", code: "SEND_NO_ANSWER" };
  if (ev.failure) return { ...base, submission: "not-submitted", code: codeFromFailure(ev.failure) };
  return { ...base, submission: "not-submitted", code: input.error === undefined ? "SDK_ERROR" : codeFromLocalError(input.error) };
}

/** Owner-facing sentence for a claim that was NOT sent. */
export function notSubmittedMessage(code: ClaimOutcomeCode, network: string, disclosed: boolean): string {
  const why: Record<string, string> = {
    AA_CONFIG_MISSING: "the delivery service isn't configured on this device",
    AA_SPONSORSHIP_REJECTED: `the ${network} delivery sponsor declined it`,
    AA_ESTIMATE_FAILED: `the ${network} delivery check failed`,
    AA_UNREACHABLE: `the ${network} delivery service couldn't be reached`,
    RATE_LIMITED: `the ${network} delivery service is busy`,
    PROVIDER_READ_FAILED: "the provider couldn't be read",
    DEX_CALLDATA_FAILED: "the provider couldn't prepare the delivery",
    RECOVERY_MATERIAL_MISSING: "this device doesn't hold the payment's recovery data",
    SEND_REJECTED: `the ${network} delivery service refused it`,
  };
  const reason = why[code] ?? "the delivery software stopped before sending";
  const disclosure = disclosed ? ` The payment secret was shared with the ${network} delivery service for that check, but nothing was submitted.` : "";
  return `Delivery wasn't sent: ${reason} (${code}). Nothing reached ${network}.${disclosure} Don't pay again — if it can't be finished before the deadline, the provider refunds and your NIM can be reclaimed.`;
}
