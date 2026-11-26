export type SendNavigation =
  | { kind: "new"; explicit: boolean }
  | { kind: "resume"; transferId: string }
  | { kind: "repeat"; routeId: string; address: string; name: string | null; amount: string | null };

/** One-tap repeat of a past payment: recipient, route and the same amount. */
export function repeatHref(input: { routeId: string; address: string; name?: string | null; amount?: string | null }): string {
  const params = new URLSearchParams({ intent: "repeat", route: input.routeId, to: input.address });
  if (input.name) params.set("name", input.name.slice(0, 60));
  if (input.amount) params.set("amount", input.amount);
  return `/app/send?${params.toString()}`;
}

/**
 * Resolve the send tab's navigation contract. A new-payment marker always
 * wins over a stale resume query, so a mobile "New payment" tap cannot adopt
 * an older recovery pointer. Resume remains available only through an
 * explicit Activity/deep-link action.
 */
export function resolveSendNavigation(search: string, mode: "send" | "request" = "send"): SendNavigation {
  const params = new URLSearchParams(search);
  if (mode === "send" && params.get("intent") === "new") return { kind: "new", explicit: true };
  if (mode === "send") {
    const transferId = params.get("resume")?.trim() ?? "";
    if (transferId) return { kind: "resume", transferId };
    if (params.get("intent") === "repeat") {
      const routeId = params.get("route")?.trim() ?? "";
      const address = params.get("to")?.trim() ?? "";
      const amount = params.get("amount")?.trim() ?? "";
      if (routeId && address) {
        return {
          kind: "repeat",
          routeId,
          address,
          name: params.get("name")?.trim() || null,
          amount: /^\d+(\.\d{1,8})?$/.test(amount) && amount !== "0" ? amount : null,
        };
      }
    }
  }
  return { kind: "new", explicit: false };
}

export const NEW_PAYMENT_HREF = "/app/send?intent=new";
