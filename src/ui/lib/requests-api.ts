/**
 * Payment requests ("Request money") — typed against the B2.2 handlers
 * (src/lib/requests.ts). A request is an immutable snapshot: amount,
 * currency, network and wallet can't change after creation; only the
 * creator can cancel it. Creating or opening one moves no money.
 */
import { routeIdForPair, type RouteId } from "@/domain/routes";
import { apiRequest, type ApiOptions, type ApiResult } from "./api";

export type RequestStatus = "active" | "expired" | "cancelled";

/** Exactly the public view: no owner ids, no recipient-book data. */
export interface ApiPublicRequest {
  publicId: string;
  recipientName: string;
  amount: string;
  amountAtomic: string;
  asset: string;
  network: string;
  destination: string;
  memo: string | null;
  expiresAt: string | null;
  status: RequestStatus;
  route: { id: string; supported: boolean; quoteable: boolean };
  url: string;
}

export interface ApiOwnerRequest extends ApiPublicRequest {
  id: string;
  createdAt: string;
  cancelledAt: string | null;
}

export interface RequestPage {
  requests: ApiOwnerRequest[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RequestDraft {
  recipientName: string;
  asset: string;
  network: string;
  address: string;
  /** Human decimal amount ("25.5"); the server converts it exactly. */
  amount: string;
  memo?: string | null;
}

type Opts = Pick<ApiOptions, "signal" | "fetch">;

export function createPaymentRequest(draft: RequestDraft, opts: Opts = {}): Promise<ApiResult<{ request: ApiOwnerRequest }>> {
  const body: Record<string, string> = {
    recipientName: draft.recipientName.trim(),
    asset: draft.asset,
    network: draft.network,
    address: draft.address.trim(),
    amount: draft.amount,
  };
  if (draft.memo?.trim()) body["memo"] = draft.memo.trim();
  return apiRequest("/api/requests", { ...opts, method: "POST", body });
}

export function listPaymentRequests(params: { status?: RequestStatus | "all"; page?: number; pageSize?: number } = {}, opts: Opts = {}): Promise<ApiResult<RequestPage>> {
  const search = new URLSearchParams({
    status: params.status ?? "all",
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 50),
  });
  return apiRequest(`/api/requests?${search}`, opts);
}

export function getPublicRequest(publicId: string, opts: Opts = {}): Promise<ApiResult<{ request: ApiPublicRequest }>> {
  return apiRequest(`/api/requests/${encodeURIComponent(publicId)}`, opts);
}

export function cancelPaymentRequest(publicId: string, opts: Opts = {}): Promise<ApiResult<{ request: ApiOwnerRequest }>> {
  return apiRequest(`/api/requests/${encodeURIComponent(publicId)}`, { ...opts, method: "PATCH", body: { action: "cancel" } });
}

/* ---------- view helpers ---------- */

/** Public ids are 22-char base64url; anything else is never fetched or linked. */
export function isPublicId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function requestRouteId(request: Pick<ApiPublicRequest, "asset" | "network">): RouteId | null {
  return routeIdForPair(request.asset, request.network);
}

/** Only active requests on a currently payable route may be paid. */
export function canPayRequest(request: Pick<ApiPublicRequest, "status" | "route" | "asset" | "network">): boolean {
  return request.status === "active" && request.route.quoteable && requestRouteId(request) !== null;
}

export function requestStatusLabel(status: RequestStatus): string {
  return status === "active" ? "Active" : status === "expired" ? "Expired" : "Cancelled";
}

/**
 * Full link for copying/sharing. The server returns an absolute URL only
 * when a trusted origin is configured; otherwise a relative path is joined
 * to the origin the person is actually using. Never a guessed domain.
 */
export function absoluteShareUrl(url: string, currentOrigin: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${currentOrigin.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

/** Send-flow link that pays a request with its immutable terms. */
export function payRequestHref(publicId: string): string {
  return `/app/send?request=${encodeURIComponent(publicId)}`;
}

export function formatRequestDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const REQUEST_CODES: Record<string, { field: "address" | "amount" | "name" | "form"; message: string }> = {
  INVALID_ADDRESS: { field: "address", message: "That wallet address doesn't look right for this network. Check it and try again." },
  BOLT11_NOT_REUSABLE: { field: "address", message: "That's a one-time Lightning invoice, not a wallet." },
  LIGHTNING_DESTINATION_PENDING: { field: "form", message: "Lightning requests aren't available yet. Choose another currency." },
  UNSUPPORTED_ROUTE: { field: "form", message: "That currency and network can't be requested." },
  BAD_AMOUNT: { field: "amount", message: "That amount can't be requested. Check it and try again." },
  BAD_EXPIRY: { field: "form", message: "That request would last too long." },
};

export function requestFormError(code: string | null): { field: "address" | "amount" | "name" | "form"; message: string } | null {
  return code ? (REQUEST_CODES[code] ?? null) : null;
}
