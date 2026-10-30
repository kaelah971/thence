import type { RouteId } from "@/domain/routes";
import type { FormError } from "@/ui/components/DestinationForm";
import { friendlyMessage, type ApiOptions, type ApiResult } from "./api";
import { destinationFor } from "./assets";
import { addDestination, createRecipient, updateDestination, updateRecipient } from "./recipients-api";
import { invalidateData } from "./resource";

type Opts = Pick<ApiOptions, "fetch">;

const ADDRESS_CODES = new Set(["INVALID_ADDRESS", "UNSUPPORTED_ROUTE", "BOLT11_NOT_REUSABLE", "LIGHTNING_DESTINATION_PENDING"]);

export function toFormError(result: Extract<ApiResult<unknown>, { ok: false }>, field: FormError["field"]): FormError {
  if (result.code && ADDRESS_CODES.has(result.code)) return { field: "address", message: friendlyMessage(result) };
  if (result.code === "BAD_BODY" && field === "name") return { field: "name", message: "Check their name and try again." };
  if (result.kind === "invalid" && field === "address") return { field: "address", message: friendlyMessage(result) };
  return { field: "form", message: friendlyMessage(result) };
}

function walletBody(routeId: RouteId, address: string) {
  const { asset, network } = destinationFor(routeId);
  return { asset, network, address };
}

/**
 * "Add a person": create the recipient, then their first receiving wallet
 * (which the server makes preferred). If the wallet step fails, the caller
 * keeps `recipientId` and retries only the wallet — no duplicate people.
 */
export async function addPerson(
  draft: { name: string; routeId: RouteId; address: string },
  existingRecipientId: string | null,
  opts: Opts = {},
): Promise<{ recipientId: string | null; error: FormError | null }> {
  let recipientId = existingRecipientId;
  if (!recipientId) {
    const created = await createRecipient(draft.name, opts);
    if (!created.ok) return { recipientId: null, error: toFormError(created, "name") };
    recipientId = created.data.recipient.id;
    invalidateData();
  }
  const wallet = await addDestination(recipientId, { ...walletBody(draft.routeId, draft.address), isDefault: true }, opts);
  if (!wallet.ok) return { recipientId, error: toFormError(wallet, "address") };
  invalidateData();
  return { recipientId, error: null };
}

export async function renamePerson(recipientId: string, name: string, opts: Opts = {}): Promise<FormError | null> {
  const result = await updateRecipient(recipientId, { displayName: name }, opts);
  if (!result.ok) return toFormError(result, "name");
  invalidateData();
  return null;
}

export async function setArchived(recipientId: string, archived: boolean, opts: Opts = {}): Promise<FormError | null> {
  const result = await updateRecipient(recipientId, { archived }, opts);
  if (!result.ok) return toFormError(result, "form");
  invalidateData();
  return null;
}

export async function addWallet(
  recipientId: string,
  draft: { routeId: RouteId; address: string; makePreferred: boolean },
  opts: Opts = {},
): Promise<FormError | null> {
  const result = await addDestination(recipientId, { ...walletBody(draft.routeId, draft.address), isDefault: draft.makePreferred }, opts);
  if (!result.ok) return toFormError(result, "address");
  invalidateData();
  return null;
}

export async function editWallet(recipientId: string, destinationId: string, draft: { routeId: RouteId; address: string }, opts: Opts = {}): Promise<FormError | null> {
  const result = await updateDestination(recipientId, destinationId, walletBody(draft.routeId, draft.address), opts);
  if (!result.ok) return toFormError(result, "address");
  invalidateData();
  return null;
}

export async function makePreferred(recipientId: string, destinationId: string, opts: Opts = {}): Promise<FormError | null> {
  const result = await updateDestination(recipientId, destinationId, { isDefault: true }, opts);
  if (!result.ok) return toFormError(result, "form");
  invalidateData();
  return null;
}
