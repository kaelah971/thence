/**
 * F3.1 — data mapping, availability, API client and error language.
 * Pure tests; the live-database flow is in tests/f3-data.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSFER_STATUSES, type TransferStatus } from "@/domain/transfers";
import { apiRequest, friendlyMessage, setUnauthorizedHandler, type ApiFailureKind } from "@/ui/lib/api";
import { toFormError } from "@/ui/lib/recipient-actions";
import { canSaveNetwork, isWalletVerified, toRecipientView, type ApiRecipientSummary } from "@/ui/lib/recipients-api";
import { availabilityFor, sortByAvailability, type RouteCatalogue } from "@/ui/lib/routes-api";
import { pillLabel, timelineFor } from "@/ui/lib/status";
import { canHaveReceipt, dayLabelFor, humanAmount, toActivityItem, type ApiTransfer } from "@/ui/lib/transfers-api";

const summary = (over: Partial<ApiRecipientSummary> = {}): ApiRecipientSummary => ({
  id: "r1",
  displayName: "Daniel",
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  defaultDestination: {
    id: "d1",
    asset: "USDC",
    network: "Polygon",
    address: "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21",
    label: null,
    verification: { status: "added-by-you" },
  },
  destinationCount: 1,
  transferCount: 0,
  lastPaidAt: null,
  ...over,
});

const transfer = (over: Partial<ApiTransfer> = {}): ApiTransfer => ({
  id: "t1",
  status: "SERVER_FUNDED",
  statusLabel: "Sending",
  routeId: "usdc-polygon",
  recipientName: "Daniel",
  asset: "USDC",
  network: "Polygon",
  destination: "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21",
  targetAmountAtomic: "25500000",
  recipientDestinationId: "d1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("recipient mapping", () => {
  it("reads the preferred wallet and currency from the server", () => {
    const view = toRecipientView(summary());
    expect(view).toMatchObject({ id: "r1", name: "Daniel", routeId: "usdc-polygon", walletVerified: false, archived: false });
  });

  it("shows Wallet verified only when the server reports a recipient verification", () => {
    expect(toRecipientView(summary()).walletVerified).toBe(false);
    const verified = summary({
      defaultDestination: { ...summary().defaultDestination!, verification: { status: "verified-by-recipient", verifiedAt: "2026-10-02T00:00:00Z" } },
    });
    expect(toRecipientView(verified).walletVerified).toBe(true);
    expect(isWalletVerified(undefined)).toBe(false);
    expect(isWalletVerified({ status: "added-by-you" })).toBe(false);
  });

  it("handles people without a receiving wallet and archived people", () => {
    const none = toRecipientView(summary({ defaultDestination: null, destinationCount: 0 }));
    expect(none).toMatchObject({ routeId: null, address: null, walletVerified: false });
    expect(toRecipientView(summary({ archivedAt: "2026-10-03T00:00:00Z" })).archived).toBe(true);
  });

  it("never guesses a route for an unknown pair", () => {
    const odd = summary({ defaultDestination: { ...summary().defaultDestination!, asset: "DAI", network: "Polygon" } });
    expect(toRecipientView(odd).routeId).toBeNull();
  });

  it("does not offer Lightning when saving (the server rejects reusable Lightning wallets)", () => {
    expect(canSaveNetwork("Lightning")).toBe(false);
    expect(canSaveNetwork("Polygon")).toBe(true);
  });
});

describe("activity mapping", () => {
  it("converts atomic amounts exactly and keeps the server status label", () => {
    const item = toActivityItem(transfer());
    expect(item).toMatchObject({ amount: "25.5", routeId: "usdc-polygon", status: "SERVER_FUNDED", statusLabel: "Sending", name: "Daniel" });
    expect(humanAmount("1", "USDC")).toBe("0.000001");
    expect(humanAmount("12345678", "BTC")).toBe("0.12345678");
    expect(humanAmount("-1", "USDC")).toBeNull();
  });

  it("skips unknown statuses and malformed amounts instead of guessing", () => {
    expect(toActivityItem(transfer({ status: "MADE_UP" }))).toBeNull();
    expect(toActivityItem(transfer({ targetAmountAtomic: "1.5" }))).toBeNull();
    expect(toActivityItem(transfer({ routeId: "nope", asset: "XYZ" }))).toBeNull();
  });

  it("labels people without a saved name plainly", () => {
    expect(toActivityItem(transfer({ recipientName: null }))?.name).toBe("Someone new");
  });

  it("uses everyday status labels and only says Delivered for DELIVERED", () => {
    expect(pillLabel("QUOTED")).toBe("Preparing payment");
    expect(pillLabel("AWAITING_NIM_APPROVAL")).toBe("Waiting for approval");
    expect(pillLabel("CLAIMING")).toBe("Verifying delivery");
    expect(pillLabel("SERVER_FUNDED")).toBe("Finish delivery needed");
    expect(pillLabel("CLIENT_FUNDED")).toBe("Preparing delivery");
    expect(pillLabel("RECONCILING")).toBe("Checking your payment");
    expect(pillLabel("NEEDS_ATTENTION")).toBe("Needs your attention");
    for (const status of TRANSFER_STATUSES) {
      expect(pillLabel(status) === "Delivered").toBe(status === "DELIVERED");
      expect(timelineFor(status).at(-1)?.state === "done").toBe(status === "DELIVERED");
    }
  });

  it("requests receipts only for delivered transfers", () => {
    for (const status of TRANSFER_STATUSES) expect(canHaveReceipt(status as TransferStatus)).toBe(status === "DELIVERED");
  });

  it("groups by friendly day", () => {
    const now = new Date("2026-10-29T12:00:00");
    expect(dayLabelFor("2026-10-29T08:00:00", now)).toBe("Today");
    expect(dayLabelFor("2026-10-28T23:00:00", now)).toBe("Yesterday");
    expect(dayLabelFor("2026-10-20T10:00:00", now)).not.toMatch(/Today|Yesterday/);
  });
});

describe("route availability comes only from the server", () => {
  const catalogue: RouteCatalogue = {
    providerFresh: true,
    routes: [
      { id: "usdc-polygon", asset: "USDC", network: "Polygon", enabled: true, supported: true, quoteable: true, status: "live" },
      { id: "usdt-polygon", asset: "USDT", network: "Polygon", enabled: true, supported: true, quoteable: false, status: "unavailable-token" },
      { id: "usdc-base", asset: "USDC", network: "Base", enabled: false, supported: true, quoteable: false, status: "disabled" },
      { id: "btc-lightning", asset: "BTC", network: "Lightning", enabled: true, supported: true, quoteable: false, status: "host-dependent" },
      { id: "usdc-arbitrum", asset: "USDC", network: "Arbitrum", enabled: true, supported: true, quoteable: false, status: "unknown" },
    ],
  };

  it("marks only live, quoteable, enabled routes as available", () => {
    expect(availabilityFor("usdc-polygon", catalogue).availability).toBe("available");
    expect(availabilityFor("usdt-polygon", catalogue)).toEqual({ availability: "unavailable", note: "Not available right now" });
    expect(availabilityFor("usdc-base", catalogue).availability).toBe("unavailable");
    expect(availabilityFor("btc-lightning", catalogue).availability).toBe("host-dependent");
    expect(availabilityFor("usdc-arbitrum", catalogue).availability).toBe("unknown");
  });

  it("never treats a supported-but-not-quoteable route as payable", () => {
    const tricky: RouteCatalogue = { providerFresh: true, routes: [{ ...catalogue.routes[0]!, quoteable: false }] };
    expect(availabilityFor("usdc-polygon", tricky).availability).not.toBe("available");
  });

  it("reports unknown (not available) when the catalogue is missing or stale", () => {
    expect(availabilityFor("usdc-polygon", null).availability).toBe("unknown");
    expect(availabilityFor("usdc-ethereum", catalogue).availability).toBe("unknown");
    expect(availabilityFor("usdc-polygon", { ...catalogue, providerFresh: false }).note).toBe("Availability may be out of date");
  });

  it("orders available options first", () => {
    expect(sortByAvailability(["usdt-polygon", "usdc-polygon", "btc-lightning"], catalogue)).toEqual(["usdc-polygon", "btc-lightning", "usdt-polygon"]);
  });
});

describe("API client", () => {
  afterEach(() => setUnauthorizedHandler(() => {}));

  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("sends same-origin credentials and parses success", async () => {
    let init: RequestInit | undefined;
    const ok = await apiRequest<{ a: number }>("/api/x", {
      fetch: (async (_url: RequestInfo | URL, i?: RequestInit) => ((init = i), new Response('{"a":1}', { status: 200 }))) as typeof fetch,
    });
    expect(ok).toEqual({ ok: true, status: 200, data: { a: 1 } });
    expect(init?.credentials).toBe("same-origin");
  });

  it("signals session expiry on 401 so the app can reconnect", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const result = await apiRequest("/api/recipients", { fetch: respond(401, { error: "UNAUTHORIZED" }) });
    expect(result).toMatchObject({ ok: false, kind: "unauthorized" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("classifies failures", async () => {
    const cases: Array<[number, ApiFailureKind]> = [[400, "invalid"], [403, "invalid"], [404, "not-found"], [409, "conflict"], [429, "rate-limited"], [500, "server"], [503, "server"]];
    for (const [status, kind] of cases) {
      expect(await apiRequest("/x", { fetch: respond(status, { error: "X" }) })).toMatchObject({ ok: false, kind });
    }
    const offline = await apiRequest("/x", { fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch });
    expect(offline).toMatchObject({ ok: false, kind: "network" });
  });

  it("speaks everyday language, never raw codes or jargon", () => {
    const kinds: ApiFailureKind[] = ["unauthorized", "not-found", "invalid", "conflict", "rate-limited", "server", "network"];
    for (const kind of kinds) {
      const message = friendlyMessage({ kind, code: "SOME_CODE" });
      expect(message).not.toMatch(/API|token|route ID|reconciliation|SOME_CODE|HTTP|\d{3}/i);
      expect(message.length).toBeGreaterThan(10);
    }
    expect(friendlyMessage({ kind: "invalid", code: "INVALID_ADDRESS" })).toMatch(/wallet address/);
    expect(friendlyMessage({ kind: "invalid", code: "UNSUPPORTED_ROUTE" })).not.toMatch(/route/i);
  });

  it("puts address problems next to the address field", () => {
    expect(toFormError({ ok: false, status: 400, kind: "invalid", code: "INVALID_ADDRESS" }, "name").field).toBe("address");
    expect(toFormError({ ok: false, status: 400, kind: "invalid", code: "BAD_BODY" }, "name").field).toBe("name");
    expect(toFormError({ ok: false, status: 0, kind: "network", code: null }, "address").field).toBe("form");
  });
});

describe("no preview data in real runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("disables preview fixtures in production builds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const stores = await import("@/ui/lib/stores");
    expect(stores.PREVIEW_ALLOWED).toBe(false);
  });

  it("real mappings never produce fixture records", () => {
    const view = toRecipientView(summary({ id: "real-1" }));
    expect(view.id).toBe("real-1");
    expect(view.id.startsWith("p-")).toBe(false);
  });
});
