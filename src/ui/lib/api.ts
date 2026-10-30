/**
 * Small typed client for Thence's own API.
 *
 * - Same-origin only; the HttpOnly session cookie is sent by the browser
 *   and is never readable here.
 * - Every failure is classified, and `friendlyMessage` turns backend codes
 *   into everyday language (never "API error" or raw codes).
 * - A 401 tells the session store to re-check, which moves the user to the
 *   reconnect screen instead of showing a broken page.
 */

export type ApiFailureKind =
  | "unauthorized"
  | "not-found"
  | "invalid"
  | "conflict"
  | "rate-limited"
  | "server"
  | "network"
  | "aborted";

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; kind: ApiFailureKind; code: string | null };

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Test seam. */
  fetch?: typeof fetch;
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Wired by the session store; kept as a setter to avoid an import cycle. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

function kindFor(status: number): ApiFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 403 || status === 413 || status === 422) return "invalid";
  return "server";
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await doFetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }
        : {}),
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return { ok: false, status: 0, kind: aborted ? "aborted" : "network", code: null };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) return { ok: true, status: response.status, data: payload as T };
  const code =
    payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? ((payload as { error: string }).error)
      : null;
  const kind = kindFor(response.status);
  if (kind === "unauthorized") onUnauthorized();
  return { ok: false, status: response.status, kind, code };
}

const CODE_MESSAGES: Record<string, string> = {
  INVALID_ADDRESS: "That wallet address doesn't look right for this network. Check it and try again.",
  UNSUPPORTED_ROUTE: "That currency and network combination can't be used.",
  BOLT11_NOT_REUSABLE: "That's a one-time Lightning invoice, not a wallet. Ask them for a reusable address.",
  LIGHTNING_DESTINATION_PENDING: "Lightning wallets can't be saved yet.",
  RECIPIENT_ARCHIVED: "This person is archived. Reopen them to make changes.",
  ARCHIVED: "This person is archived. Reopen them to make changes.",
  FIELD_FORBIDDEN: "Some details couldn't be saved. Check the form and try again.",
  BODY_TOO_LARGE: "That's too much text. Shorten it and try again.",
  ORIGIN_MISMATCH: "This request was blocked for your safety. Reload Thence and try again.",
  BAD_ORIGIN: "This request was blocked for your safety. Reload Thence and try again.",
};

/** Everyday-language message for a failed request. */
export function friendlyMessage(result: { kind: ApiFailureKind; code: string | null }, context: "load" | "save" = "save"): string {
  if (result.code && CODE_MESSAGES[result.code]) return CODE_MESSAGES[result.code] as string;
  switch (result.kind) {
    case "network":
      return "Couldn't reach Thence. Check your connection and try again.";
    case "rate-limited":
      return "That's a lot of requests at once. Wait a moment, then try again.";
    case "unauthorized":
      return "Your session has ended. Sign in again to continue.";
    case "not-found":
      return context === "load" ? "We couldn't find that. It may have been removed." : "That no longer exists.";
    case "conflict":
      return "That couldn't be changed right now. Refresh and try again.";
    case "invalid":
      return "Check the details and try again.";
    case "aborted":
      return "";
    case "server":
      return context === "load" ? "Something went wrong loading this. Try again." : "Something went wrong saving this. Try again.";
  }
}
