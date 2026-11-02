export type SendNavigation =
  | { kind: "new"; explicit: boolean }
  | { kind: "resume"; transferId: string };

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
  }
  return { kind: "new", explicit: false };
}

export const NEW_PAYMENT_HREF = "/app/send?intent=new";
