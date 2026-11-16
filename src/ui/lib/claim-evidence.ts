/**
 * Claim submission evidence (incident f1ca0926, 2026-11-16).
 *
 * The SDK's `claim()` either returns or throws a plain Error. Thence used to
 * treat EVERY throw as "the delivery may have been sent" and showed
 * "Delivery submitted": the f1ca0926 claim threw before anything reached
 * Arbitrum (no UserOperation, no transaction, no provider claim), yet the
 * screen said it was submitted.
 *
 * What was actually sent is recorded by observing the claim's own network
 * requests while it runs (the SDK's bundler/paymaster transport and its
 * gasless-relay POST use the global `fetch`):
 * - Arbitrum: a sponsored ERC-4337 UserOperation (EntryPoint v0.7, EIP-7702
 *   Kernel account). Submission = `eth_sendUserOperation` answered with a
 *   UserOperation hash. A JSON-RPC error answer = explicitly NOT accepted.
 * - Polygon: Satora's server-submitted gasless claim. Submission =
 *   `POST /swap/:id/claim-gasless` answered 2xx (non-2xx = not accepted).
 * A send request with no definitive answer is UNKNOWN: it may still land.
 *
 * Requests that carry the claim calldata (and so the payment preimage) to the
 * delivery infrastructure before submission (gas estimation, sponsorship)
 * are recorded as `disclosedToInfrastructure`: an honest fact for the owner
 * and the audit, not a submission.
 *
 * Nothing here reads, logs or forwards request bodies beyond the JSON-RPC
 * method names; only public hashes are kept.
 */

export type ClaimSubmission = "submitted" | "not-submitted" | "unknown";

export interface ClaimNetworkEvidence {
  /** Calldata-bearing requests made before/at submission (method names only). */
  disclosedToInfrastructure: boolean;
  sendAttempted: boolean;
  sendAccepted: boolean;
  sendRejected: boolean;
  userOpHash: string | null;
  txHash: string | null;
  /** eth_getUserOperationReceipt `success`, when a receipt was seen. */
  receiptSuccess: boolean | null;
  /** JSON-RPC methods observed, in order (names only; for diagnostics). */
  methods: string[];
}

export interface ClaimClassification {
  submission: ClaimSubmission;
  /** Stable, secret-free code for the audit log and the owner's message. */
  code: ClaimOutcomeCode;
  disclosedToInfrastructure: boolean;
  userOpHash: string | null;
  txHash: string | null;
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
  | "DEX_CALLDATA_FAILED"
  | "RECOVERY_MATERIAL_MISSING"
  | "SDK_ERROR";

/** Methods whose params carry the claim calldata (preimage) to the infrastructure. */
const CALLDATA_METHODS = new Set([
  "eth_estimateUserOperationGas",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "alchemy_requestGasAndPaymasterAndData",
  "eth_sendUserOperation",
]);
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const GASLESS_RE = /\/swap\/[^/?#]+\/claim-gasless(?:[?#].*)?$/;

export function emptyEvidence(): ClaimNetworkEvidence {
  return { disclosedToInfrastructure: false, sendAttempted: false, sendAccepted: false, sendRejected: false, userOpHash: null, txHash: null, receiptSuccess: null, methods: [] };
}

type RpcBody = { method?: unknown; id?: unknown };
type RpcReply = { id?: unknown; result?: unknown; error?: unknown };

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

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "url" in input && typeof (input as { url: unknown }).url === "string") return (input as { url: string }).url;
  if (input instanceof URL) return input.toString();
  return "";
}

/** Record one request (before it is sent). Returns the JSON-RPC methods it carries. */
function noteRequest(ev: ClaimNetworkEvidence, url: string, method: string, body: unknown): { rpc: Array<{ method: string; id: unknown }>; gasless: boolean } {
  const gasless = method.toUpperCase() === "POST" && GASLESS_RE.test(url);
  if (gasless) {
    ev.methods.push("claim-gasless");
    ev.disclosedToInfrastructure = true;
    ev.sendAttempted = true;
    return { rpc: [], gasless };
  }
  const parsed = typeof body === "string" ? (parseJson(body) as RpcBody | RpcBody[] | null) : null;
  const rpc: Array<{ method: string; id: unknown }> = [];
  for (const item of asArray(parsed)) {
    if (item && typeof item.method === "string") {
      rpc.push({ method: item.method, id: item.id });
      ev.methods.push(item.method);
      if (CALLDATA_METHODS.has(item.method)) ev.disclosedToInfrastructure = true;
      if (item.method === "eth_sendUserOperation") ev.sendAttempted = true;
    }
  }
  return { rpc, gasless };
}

/** Record the answer to a request already noted. */
function noteResponse(ev: ClaimNetworkEvidence, req: { rpc: Array<{ method: string; id: unknown }>; gasless: boolean }, status: number, text: string): void {
  const parsed = parseJson(text);
  if (req.gasless) {
    if (status >= 200 && status < 300) {
      ev.sendAccepted = true;
      const tx = (parsed as { tx_hash?: unknown } | null)?.tx_hash;
      if (typeof tx === "string" && HASH_RE.test(tx)) ev.txHash = tx;
    } else if (status >= 400 && status < 500) {
      // 4xx is a definitive refusal; 5xx may hide an accepted submission.
      ev.sendRejected = true;
    }
    return;
  }
  const replies = asArray(parsed as RpcReply | RpcReply[] | null);
  for (const r of req.rpc) {
    const reply = replies.find((x) => x && x.id === r.id) ?? (replies.length === 1 ? replies[0] : undefined);
    if (!reply) continue;
    if (r.method === "eth_sendUserOperation") {
      if (typeof reply.result === "string" && HASH_RE.test(reply.result)) {
        ev.sendAccepted = true;
        ev.userOpHash = reply.result;
      } else if (reply.error !== undefined && reply.error !== null) {
        ev.sendRejected = true;
      }
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

/**
 * Run `fn` while observing every global `fetch` it makes. The original fetch
 * is always restored. One claim runs at a time per page (claimsInFlight), so
 * the observer never sees an unrelated claim; unrelated requests are recorded
 * only by method name and never change the classification unless they are
 * claim submissions.
 */
export async function observeClaimNetwork<T>(
  fn: () => Promise<T>,
  scope: { fetch: FetchLike } = globalThis as unknown as { fetch: FetchLike },
): Promise<{ ok: true; value: T; evidence: ClaimNetworkEvidence } | { ok: false; error: unknown; evidence: ClaimNetworkEvidence }> {
  const ev = emptyEvidence();
  const original = scope.fetch;
  const pending: Promise<void>[] = [];
  const observed: FetchLike = async (input, init) => {
    const req = noteRequest(ev, urlOf(input), String(init?.method ?? "GET"), init?.body);
    const response = await original.call(scope, input, init);
    if (req.gasless || req.rpc.length > 0) {
      pending.push(
        response
          .clone()
          .text()
          .then((text) => noteResponse(ev, req, response.status, text))
          .catch(() => undefined),
      );
    }
    return response;
  };
  scope.fetch = observed;
  try {
    const value = await fn();
    await Promise.all(pending);
    return { ok: true, value, evidence: ev };
  } catch (error) {
    await Promise.all(pending);
    return { ok: false, error, evidence: ev };
  } finally {
    scope.fetch = original;
  }
}

/** Secret-free, bounded error text: hex runs (calldata, signatures, preimages) are removed. */
export function sanitizeClaimError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw.replace(/0x[0-9a-fA-F]{16,}/g, "0x…").replace(/[0-9a-fA-F]{40,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 160);
}

function codeFromError(error: unknown, ev: ClaimNetworkEvidence): ClaimOutcomeCode {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/requires AA config|aa\.bundlerUrl is required/i.test(msg)) return "AA_CONFIG_MISSING";
  if (/not found in local storage|storage is not configured|no target address/i.test(msg)) return "RECOVERY_MATERIAL_MISSING";
  if (/dex-calldata|redeem calldata/i.test(msg)) return "DEX_CALLDATA_FAILED";
  if (/reverted on-chain/i.test(msg)) return "USEROP_REVERTED";
  if (/WaitForUserOperationReceiptTimeout|Timed out while waiting for User Operation/i.test(msg)) return "RECEIPT_TIMEOUT";
  if (/paymaster|sponsor|policy|gas manager/i.test(msg)) return "AA_SPONSORSHIP_REJECTED";
  if (/estimate|simulat|AA[1-5]\d|execution reverted|revert/i.test(msg)) return "AA_ESTIMATE_FAILED";
  if (/fetch|network|timed? ?out|ECONN|HTTP request failed|status 5\d\d/i.test(msg)) return ev.sendAttempted ? "SEND_NO_ANSWER" : "AA_UNREACHABLE";
  return "SDK_ERROR";
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
  const base = { disclosedToInfrastructure: ev.disclosedToInfrastructure, userOpHash: ev.userOpHash, txHash };
  if (input.error === undefined && input.sdkSuccess === true) {
    return { ...base, submission: "submitted", code: ev.receiptSuccess === true ? "CONFIRMED" : "SUBMITTED" };
  }
  if (ev.sendAccepted) {
    // Accepted, then something failed (receipt wait, reverted op): the
    // operation exists; the chain decides.
    const code = input.error === undefined ? "SUBMITTED" : codeFromError(input.error, ev);
    return { ...base, submission: "submitted", code: code === "AA_UNREACHABLE" || code === "SDK_ERROR" ? "RECEIPT_TIMEOUT" : code };
  }
  if (ev.sendAttempted && !ev.sendRejected) return { ...base, submission: "unknown", code: "SEND_NO_ANSWER" };
  if (ev.sendRejected) return { ...base, submission: "not-submitted", code: "SEND_REJECTED" };
  return { ...base, submission: "not-submitted", code: input.error === undefined ? "SDK_ERROR" : codeFromError(input.error, ev) };
}

/** Owner-facing sentence for a claim that was NOT sent. */
export function notSubmittedMessage(code: ClaimOutcomeCode, network: string, disclosed: boolean): string {
  const why: Record<string, string> = {
    AA_CONFIG_MISSING: "the delivery service isn't configured on this device",
    AA_SPONSORSHIP_REJECTED: `the ${network} delivery sponsor declined it`,
    AA_ESTIMATE_FAILED: `the ${network} delivery check failed`,
    AA_UNREACHABLE: `the ${network} delivery service couldn't be reached`,
    DEX_CALLDATA_FAILED: "the provider couldn't prepare the delivery",
    RECOVERY_MATERIAL_MISSING: "this device doesn't hold the payment's recovery data",
    SEND_REJECTED: `the ${network} delivery service refused it`,
  };
  const reason = why[code] ?? "the delivery software stopped before sending";
  const disclosure = disclosed ? ` The payment secret was shared with the ${network} delivery service for that check, but nothing was submitted.` : "";
  return `Delivery wasn't sent: ${reason}. Nothing reached ${network}.${disclosure} Don't pay again — if it can't be finished before the deadline, the provider refunds and your NIM can be reclaimed.`;
}
