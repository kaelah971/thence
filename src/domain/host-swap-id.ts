/**
 * R4 — the Fastspot swap id Nimiq Pay returns from `payLightningInvoice`
 * (`{ hash, swapId }`). It identifies the wallet's NIM → Lightning swap at
 * Fastspot, so a failed payment can be traced to its actual swap.
 *
 * It is an UNTRUSTED host-provided diagnostic hint: never funding evidence,
 * never source verification, never a reason to change transfer state.
 * Fastspot does not document the id format, so validation is a conservative
 * charset and length bound only. Shared by the browser and the server.
 */
export const HOST_SWAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** The id if it is well formed, else null. Never trims or rewrites it. */
export function normalizeHostSwapId(value: unknown): string | null {
  return typeof value === "string" && HOST_SWAP_ID_RE.test(value) ? value : null;
}

/** Non-identifying prefix for logs and alerts. The full id stays operator-only. */
export function hostSwapIdPrefix(id: string): string {
  return id.slice(0, 8);
}
