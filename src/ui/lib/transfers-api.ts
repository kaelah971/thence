/**
 * Read-only transfer history (B4 handlers). F3.1 never creates, prepares,
 * authorizes or claims anything — only GET endpoints live here.
 */
import { atomicToDecimal, isAtomicAmount } from "@/domain/money";
import { pairForRouteId, ROUTE_IDS, routeIdForPair, type RouteId, type SupportedAsset } from "@/domain/routes";
import { TRANSFER_STATUSES, type TransferStatus } from "@/domain/transfers";
import type { ActivityItem } from "@/ui/components/rows";
import { apiRequest, type ApiOptions, type ApiResult } from "./api";
import { ASSET_META } from "./assets";
import { toneFor } from "./recipients-api";

export interface ApiTransfer {
  id: string;
  status: string;
  statusLabel: string;
  routeId: string;
  recipientName: string | null;
  asset: string;
  network: string;
  destination: string;
  targetAmountAtomic: string;
  recipientDestinationId: string | null;
  createdAt: string;
  updatedAt: string;
  /** R2: on-chain-verified NIM return; only ever set by the server for an R2 close. */
  nimReturn?: { refundTxHash: string; returnedLuna: string; feeLuna: string } | null;
}

export interface TransferPage {
  transfers: ApiTransfer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiReceipt {
  transferId: string;
  recipientName: string | null;
  asset: string;
  network: string;
  destination: string;
  requestedAmountAtomic: string;
  verifiedAmountAtomic: string;
  settlementTxHash: string;
  chainId: number;
  verifiedAt: string;
  explorerTxUrl: string;
  actualFundingProven: boolean;
}

type Opts = Pick<ApiOptions, "signal" | "fetch">;

export function listTransfers(params: { page?: number; pageSize?: number }, opts: Opts = {}): Promise<ApiResult<TransferPage>> {
  return apiRequest(`/api/transfers?page=${params.page ?? 1}&pageSize=${params.pageSize ?? 50}`, opts);
}

export function getTransfer(id: string, opts: Opts = {}): Promise<ApiResult<{ transfer: ApiTransfer }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}`, opts);
}

/** Receipts exist only for verified deliveries. Never request one before. */
export function canHaveReceipt(status: TransferStatus): boolean {
  return status === "DELIVERED";
}

export function getReceipt(id: string, opts: Opts = {}): Promise<ApiResult<{ receipt: ApiReceipt }>> {
  return apiRequest(`/api/transfers/${encodeURIComponent(id)}/receipt`, opts);
}

/* ---------- view mapping ---------- */

function isTransferStatus(value: string): value is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(value);
}

function resolveRoute(t: Pick<ApiTransfer, "routeId" | "asset" | "network">): RouteId | null {
  if ((ROUTE_IDS as readonly string[]).includes(t.routeId)) return t.routeId as RouteId;
  return routeIdForPair(t.asset, t.network);
}

/** Exact human amount from atomic units using the asset's on-chain precision. */
export function humanAmount(atomic: string, asset: string): string | null {
  const meta = ASSET_META[asset as SupportedAsset];
  if (!meta || !isAtomicAmount(atomic)) return null;
  return atomicToDecimal(atomic, meta.chainDecimals);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today" / "Yesterday" / "Mon 26 Oct" in the viewer's locale and timezone. */
export function dayLabelFor(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function timeLabelFor(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Map a backend transfer to the Activity row model. Unknown shapes are skipped, never guessed. */
export function toActivityItem(t: ApiTransfer, now: Date = new Date()): ActivityItem | null {
  const routeId = resolveRoute(t);
  if (!routeId || !isTransferStatus(t.status)) return null;
  const pair = pairForRouteId(routeId);
  const amount = humanAmount(t.targetAmountAtomic, pair?.asset ?? t.asset);
  if (amount === null) return null;
  const name = t.recipientName?.trim() || "Someone new";
  return {
    id: t.id,
    name,
    tone: toneFor(t.recipientDestinationId ?? t.destination),
    routeId,
    amount,
    status: t.status,
    statusLabel: t.statusLabel,
    dayLabel: dayLabelFor(t.createdAt, now),
    timeLabel: timeLabelFor(t.createdAt),
    destination: t.destination,
    nimReturn: t.status === "EXPIRED_UNFUNDED" ? (t.nimReturn ?? null) : null,
  };
}
