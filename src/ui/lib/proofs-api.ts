/**
 * A3c.2 — browser client for the public proof-of-payments API (A3c.1).
 *
 * GET /api/proofs?limit&cursor and GET /api/proofs/:id are anonymous,
 * read-only and server-gated. While publication is off the server answers
 * `404 PUBLIC_PROOFS_DISABLED`; the UI shows a deliberate "not published yet"
 * state for that, never an empty or broken page.
 *
 * The server already refuses to publish anything that is not independently
 * verified on both legs. This client re-checks the shape it renders and drops
 * any item that does not claim full verification, so a malformed or partial
 * row can never be presented as proof.
 */
import type { PublicProofFeedResult, PublicProofView } from "@/lib/global-proofs";
import { apiRequest, friendlyMessage, type ApiResult } from "./api";
import { maskAddress, padAmountDecimals } from "./assets";
import { formatLuna } from "./luna";
import { dayLabelFor, humanAmount, timeLabelFor } from "./transfers-api";

export type ProofView = PublicProofView;
export type ProofFeedPage = PublicProofFeedResult;

/** Matches the server default (`PUBLIC_PROOF_DEFAULT_LIMIT`); the server caps at 50. */
export const PROOF_PAGE_SIZE = 20;

type Opts = { signal?: AbortSignal; fetch?: typeof fetch };

export function listProofs(params: { cursor?: string | null; limit?: number } = {}, opts: Opts = {}): Promise<ApiResult<ProofFeedPage>> {
  const query = new URLSearchParams({ limit: String(params.limit ?? PROOF_PAGE_SIZE) });
  if (params.cursor) query.set("cursor", params.cursor);
  return apiRequest<ProofFeedPage>(`/api/proofs?${query.toString()}`, opts);
}

export function getProof(proofId: string, opts: Opts = {}): Promise<ApiResult<{ proof: ProofView }>> {
  return apiRequest<{ proof: ProofView }>(`/api/proofs/${encodeURIComponent(proofId)}`, opts);
}

/** How a failed proof request should be presented. */
export type ProofFailureView = { state: "unavailable" } | { state: "not-found" } | { state: "error"; message: string };

export function classifyProofFailure(result: Extract<ApiResult<unknown>, { ok: false }>): ProofFailureView {
  // Publication gate off: a deliberate product state, not an error.
  if (result.status === 404 && result.code === "PUBLIC_PROOFS_DISABLED") return { state: "unavailable" };
  if (result.status === 404) return { state: "not-found" };
  return { state: "error", message: friendlyMessage(result, "load") || "Something went wrong loading this. Try again." };
}

/* ---------------- runtime shape check ---------------- */

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const NIMIQ_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
const NIMIQ_ADDRESS = /^NQ\d{2}( [0-9A-Z]{4}){8}$/;
const POSITIVE_ATOMIC = /^(?!0+$)\d+$/;
const ATOMIC = /^\d+$/;
const CHAIN_FOR_NETWORK: Record<string, number> = { Polygon: 137, Arbitrum: 42161 };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

/** Only https explorer links are rendered. */
export function safeExplorerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * True only for an item that claims a DELIVERED payment with BOTH legs
 * independently verified and every field the proof UI shows present and
 * well-formed. Anything else is never displayed.
 */
export function isDisplayableProof(value: unknown): value is ProofView {
  const proof = record(value);
  if (!proof || typeof proof["proofId"] !== "string" || proof["proofId"].length === 0) return false;
  // R7: a short delivery is shown only with a self-consistent disclosure.
  if (proof["status"] !== "DELIVERED" && proof["status"] !== "DELIVERED_SHORT") return false;
  const verification = record(proof["verification"]);
  if (!verification || verification["overall"] !== "VERIFIED" || verification["source"] !== "VERIFIED" || verification["destination"] !== "VERIFIED") {
    return false;
  }
  const source = record(proof["source"]);
  const destination = record(proof["destination"]);
  if (!source || !destination) return false;

  if (
    source["asset"] !== "NIM" ||
    source["evidence"] !== "VERIFIED" ||
    source["verification"] !== "VERIFIED" ||
    source["decimals"] !== 5 ||
    (source["network"] !== "mainnet" && source["network"] !== "testnet") ||
    typeof source["sender"] !== "string" ||
    !NIMIQ_ADDRESS.test(source["sender"]) ||
    typeof source["amountLuna"] !== "string" ||
    !POSITIVE_ATOMIC.test(source["amountLuna"]) ||
    typeof source["feeLuna"] !== "string" ||
    !ATOMIC.test(source["feeLuna"]) ||
    typeof source["totalDebitLuna"] !== "string" ||
    !POSITIVE_ATOMIC.test(source["totalDebitLuna"]) ||
    typeof source["transactionHash"] !== "string" ||
    !NIMIQ_HASH.test(source["transactionHash"]) ||
    !validDate(source["verifiedAt"])
  ) {
    return false;
  }

  const network = destination["network"];
  if (
    destination["asset"] !== "USDC" ||
    destination["decimals"] !== 6 ||
    typeof network !== "string" ||
    CHAIN_FOR_NETWORK[network] === undefined ||
    destination["chainId"] !== CHAIN_FOR_NETWORK[network] ||
    typeof destination["recipient"] !== "string" ||
    !EVM_ADDRESS.test(destination["recipient"]) ||
    typeof destination["verifiedAmountAtomic"] !== "string" ||
    !POSITIVE_ATOMIC.test(destination["verifiedAmountAtomic"]) ||
    typeof destination["transactionHash"] !== "string" ||
    !EVM_HASH.test(destination["transactionHash"]) ||
    !validDate(destination["verifiedAt"])
  ) {
    return false;
  }
  return shortDisclosureConsistent(proof["status"], destination);
}

/**
 * R7: DELIVERED must not carry a short marker; DELIVERED_SHORT must carry one
 * with requested - verified === shortfall > 0. Anything else is never shown.
 */
function shortDisclosureConsistent(status: unknown, destination: Record<string, unknown>): boolean {
  const requested = destination["requestedAmountAtomic"];
  const verified = destination["verifiedAmountAtomic"] as string;
  if (status === "DELIVERED") {
    if (destination["deliveryOutcome"] !== undefined || destination["shortfallAtomic"] !== undefined) return false;
    return typeof requested !== "string" || !ATOMIC.test(requested) || BigInt(verified) >= BigInt(requested);
  }
  const shortfall = destination["shortfallAtomic"];
  return (
    destination["deliveryOutcome"] === "SHORT" &&
    typeof requested === "string" &&
    POSITIVE_ATOMIC.test(requested) &&
    typeof shortfall === "string" &&
    POSITIVE_ATOMIC.test(shortfall) &&
    BigInt(requested) - BigInt(verified) === BigInt(shortfall)
  );
}

/** Keeps only fully verified items, without duplicates, in server order. */
export function displayableProofs(items: unknown, seen: ReadonlySet<string> = new Set()): ProofView[] {
  if (!Array.isArray(items)) return [];
  const ids = new Set(seen);
  const out: ProofView[] = [];
  for (const item of items) {
    if (!isDisplayableProof(item) || ids.has(item.proofId)) continue;
    ids.add(item.proofId);
    out.push(item);
  }
  return out;
}

/* ---------------- display model ---------------- */

export interface ProofDisplay {
  id: string;
  /** R7: "FULL" = at least the requested amount; "SHORT" = verified but below it. */
  outcome: "FULL" | "SHORT";
  /** "Delivered" or "Delivered — less than requested". */
  outcomeLabel: string;
  /** Exact shortfall, e.g. "0.000444"; null for a full delivery. */
  usdcShortfall: string | null;
  network: "Polygon" | "Arbitrum";
  /** Exact NIM locked in the verified HTLC, e.g. "2.50". */
  nimSent: string;
  nimFee: string;
  nimTotal: string;
  /** Exact USDC verified on-chain at the recipient, e.g. "0.30". */
  usdcReceived: string;
  usdcRequested: string | null;
  sender: string;
  senderShort: string;
  recipient: string;
  recipientShort: string;
  /** Delivery verification time (the feed's ordering key). */
  dayLabel: string;
  timeLabel: string;
  dateTimeLabel: string;
  sourceTxHash: string;
  sourceExplorerUrl: string | null;
  sourceConfirmations: number | null;
  sourceBlock: string | null;
  sourceNetworkLabel: string;
  destinationTxHash: string;
  destinationExplorerUrl: string | null;
  destinationBlock: string | null;
  finalityLabel: string | null;
  tokenContract: string | null;
  note: string | null;
  /** How each leg was checked, with qualified finality wording; null when absent or malformed. */
  method: ProofMethodDisplay | null;
}

export interface ProofMethodDisplay {
  kindLabel: string;
  sourceChecked: string;
  destinationChecked: string;
  sourceFinality: string;
  destinationFinality: string;
}

function boundedText(value: unknown, max = 240): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
}

/** Parse the server method block defensively; unknown kinds or oversize text are dropped. */
export function toMethodDisplay(value: unknown): ProofMethodDisplay | null {
  const m = record(value);
  if (!m) return null;
  const kind = m["kind"];
  if (kind !== "reconciliation" && kind !== "historical-recovery") return null;
  const sourceFinality = boundedText(m["sourceFinality"]);
  const destinationFinality = boundedText(m["destinationFinality"]);
  if (!sourceFinality || !destinationFinality) return null;
  const sourceRpc = m["sourceRpc"] === null ? null : boundedText(m["sourceRpc"], 80);
  const rpcs = Array.isArray(m["destinationRpcs"])
    ? (m["destinationRpcs"] as unknown[]).map((r) => boundedText(r, 80)).filter((r): r is string => r !== null)
    : [];
  return {
    kindLabel: kind === "historical-recovery" ? "Historical recovery (operator-run, append-only record)" : "Checked when the payment completed",
    // Never imply Thence operates the node when the server did not name it.
    sourceChecked: sourceRpc ?? "A Nimiq RPC configured by Thence (operator not recorded)",
    destinationChecked: rpcs.length > 0 ? rpcs.join(" and ") : "Thence’s configured Polygon RPC",
    sourceFinality,
    destinationFinality,
  };
}

/** "NQ12 … 9ABC" — first and last group of a user-friendly Nimiq address. */
export function compactNimiqAddress(address: string): string {
  const groups = address.trim().split(/\s+/);
  if (groups.length < 3) return address;
  return `${groups[0]} … ${groups[groups.length - 1]}`;
}

/** Explorer host for link labels ("polygonscan.com"). */
export function explorerHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function finalityLabel(level: unknown): string | null {
  if (typeof level !== "string" || level.length === 0) return null;
  if (level === "finalized") return "Finalized";
  const confirmations = /^confirmations[:_-]?(\d+)$/i.exec(level);
  if (confirmations) return `${confirmations[1]} confirmations`;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function toProofDisplay(proof: ProofView, now: Date = new Date()): ProofDisplay {
  const { source, destination } = proof;
  const received = humanAmount(destination.verifiedAmountAtomic, "USDC");
  const requested = typeof destination.requestedAmountAtomic === "string" ? humanAmount(destination.requestedAmountAtomic, "USDC") : null;
  const at = destination.verifiedAt;
  const dayLabel = dayLabelFor(at, now);
  const timeLabel = timeLabelFor(at);
  const short = proof.status === "DELIVERED_SHORT" && typeof destination.shortfallAtomic === "string" ? humanAmount(destination.shortfallAtomic, "USDC") : null;
  return {
    id: proof.proofId,
    outcome: short ? "SHORT" : "FULL",
    outcomeLabel: short ? "Delivered — less than requested" : "Delivered",
    usdcShortfall: short ? padAmountDecimals(short, "USDC") : null,
    network: destination.network,
    nimSent: formatLuna(BigInt(source.amountLuna)).text,
    nimFee: formatLuna(BigInt(source.feeLuna)).text,
    nimTotal: formatLuna(BigInt(source.totalDebitLuna)).text,
    usdcReceived: received === null ? "—" : padAmountDecimals(received, "USDC"),
    usdcRequested: requested === null ? null : padAmountDecimals(requested, "USDC"),
    sender: source.sender,
    senderShort: compactNimiqAddress(source.sender),
    recipient: destination.recipient,
    recipientShort: maskAddress(destination.recipient),
    dayLabel,
    timeLabel,
    dateTimeLabel: `${dayLabel}, ${timeLabel}`,
    sourceTxHash: source.transactionHash,
    sourceExplorerUrl: safeExplorerUrl(source.explorerTxUrl),
    sourceConfirmations: typeof source.confirmations === "number" && Number.isFinite(source.confirmations) ? source.confirmations : null,
    sourceBlock: typeof source.blockNumber === "string" && source.blockNumber.length > 0 ? source.blockNumber : null,
    sourceNetworkLabel: source.network === "mainnet" ? "Nimiq" : "Nimiq testnet",
    destinationTxHash: destination.transactionHash,
    destinationExplorerUrl: safeExplorerUrl(destination.explorerTxUrl),
    destinationBlock: typeof destination.blockNumber === "string" && destination.blockNumber.length > 0 ? destination.blockNumber : null,
    finalityLabel: finalityLabel(destination.finalityLevel),
    tokenContract: typeof destination.tokenContract === "string" && EVM_ADDRESS.test(destination.tokenContract) ? destination.tokenContract : null,
    note: typeof source.note === "string" && source.note.trim().length > 0 ? source.note.trim() : null,
    method: toMethodDisplay((proof as unknown as Record<string, unknown>)["method"]),
  };
}

/** "0x1234ab…cd9f" for hashes in compact rows; the full value is always available beside it. */
export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
