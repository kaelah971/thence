/**
 * Recipients & receiving wallets — typed against the B2 handlers
 * (src/lib/recipients.ts). Ownership and address validation stay on the
 * server; nothing here can mark a wallet as verified.
 */
import { routeIdForPair, type RouteId } from "@/domain/routes";
import type { AvatarTone } from "@/ui/fixtures/preview";
import { apiRequest, type ApiOptions, type ApiResult } from "./api";

export type VerificationStatus = { status: "added-by-you" } | { status: "verified-by-recipient"; verifiedAt: string };

export interface ApiDestination {
  id: string;
  asset: string;
  network: string;
  address: string;
  label: string | null;
  isDefault: boolean;
  verification: VerificationStatus;
  createdAt: string;
}

export interface ApiRecipientSummary {
  id: string;
  displayName: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  defaultDestination: Omit<ApiDestination, "isDefault" | "createdAt"> | null;
  destinationCount: number;
  transferCount: number;
  lastPaidAt: string | null;
}

export interface ApiRecipientDetail extends Omit<ApiRecipientSummary, "defaultDestination"> {
  destinations: ApiDestination[];
}

export interface RecipientPage {
  recipients: ApiRecipientSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DestinationInput {
  asset: string;
  network: string;
  address: string;
  label?: string | null;
  isDefault?: boolean;
}

type Opts = Pick<ApiOptions, "signal" | "fetch">;

export function listRecipients(params: { q?: string; archived?: boolean; page?: number; pageSize?: number }, opts: Opts = {}): Promise<ApiResult<RecipientPage>> {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.archived) search.set("archived", "true");
  search.set("page", String(params.page ?? 1));
  search.set("pageSize", String(params.pageSize ?? 50));
  return apiRequest<RecipientPage>(`/api/recipients?${search}`, opts);
}

export function getRecipient(id: string, opts: Opts = {}): Promise<ApiResult<{ recipient: ApiRecipientDetail }>> {
  return apiRequest(`/api/recipients/${encodeURIComponent(id)}`, opts);
}

export function createRecipient(displayName: string, opts: Opts = {}): Promise<ApiResult<{ recipient: ApiRecipientSummary }>> {
  return apiRequest("/api/recipients", { ...opts, method: "POST", body: { displayName } });
}

export function updateRecipient(id: string, patch: { displayName?: string; archived?: boolean }, opts: Opts = {}): Promise<ApiResult<{ recipient: ApiRecipientSummary }>> {
  return apiRequest(`/api/recipients/${encodeURIComponent(id)}`, { ...opts, method: "PATCH", body: patch });
}

export function addDestination(recipientId: string, input: DestinationInput, opts: Opts = {}): Promise<ApiResult<{ destination: ApiDestination }>> {
  return apiRequest(`/api/recipients/${encodeURIComponent(recipientId)}/destinations`, { ...opts, method: "POST", body: input });
}

export function updateDestination(
  recipientId: string,
  destinationId: string,
  patch: Partial<DestinationInput>,
  opts: Opts = {},
): Promise<ApiResult<{ destination: ApiDestination }>> {
  return apiRequest(`/api/recipients/${encodeURIComponent(recipientId)}/destinations/${encodeURIComponent(destinationId)}`, {
    ...opts,
    method: "PATCH",
    body: patch,
  });
}

/* ---------- view mapping ---------- */

const TONES: AvatarTone[] = ["mint", "sky", "sun", "coral", "sand"];

/** Stable avatar colour per recipient id (decorative only). */
export function toneFor(id: string): AvatarTone {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length] as AvatarTone;
}

export function isWalletVerified(verification: VerificationStatus | null | undefined): boolean {
  return verification?.status === "verified-by-recipient";
}

export interface RecipientView {
  id: string;
  name: string;
  tone: AvatarTone;
  /** Null when the person has no receiving wallet (or an unrecognised pair). */
  routeId: RouteId | null;
  address: string | null;
  walletVerified: boolean;
  archived: boolean;
  transferCount: number;
  destinationCount: number;
}

export function toRecipientView(summary: ApiRecipientSummary): RecipientView {
  const dest = summary.defaultDestination;
  return {
    id: summary.id,
    name: summary.displayName,
    tone: toneFor(summary.id),
    routeId: dest ? routeIdForPair(dest.asset, dest.network) : null,
    address: dest?.address ?? null,
    walletVerified: isWalletVerified(dest?.verification),
    archived: summary.archivedAt !== null,
    transferCount: summary.transferCount,
    destinationCount: summary.destinationCount,
  };
}

/**
 * Wallets a person can be paid at: a known currency/network on an EVM
 * network (never a Nimiq or Lightning address). Preferred first, then newest.
 */
export function payableWallets(destinations: readonly ApiDestination[]): Array<ApiDestination & { routeId: RouteId }> {
  const out: Array<ApiDestination & { routeId: RouteId }> = [];
  for (const d of destinations) {
    const routeId = routeIdForPair(d.asset, d.network);
    if (routeId && d.network !== "Lightning") out.push({ ...d, routeId });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * Reusable Lightning destinations are rejected by the backend
 * (LIGHTNING_DESTINATION_PENDING), so they are not offered when saving.
 */
export function canSaveNetwork(network: string): boolean {
  return network !== "Lightning";
}
