import { describe, expect, it } from "vitest";
import { TRANSFER_STATUSES } from "@/domain/transfers";
import { resolveEntry } from "@/ui/lib/entry";
import { matchesFilter, pillLabel, STAGE_OF, timelineFor } from "@/ui/lib/status";
import { destinationAddressIssue, DESTINATIONS, destinationFor } from "@/ui/lib/assets";

describe("entry routing", () => {
  it("shows the tour only to first-time visitors", () => {
    expect(resolveEntry({ session: "none", profileOnboarded: null, introSeenHint: false })).toBe("/app/welcome");
  });

  it("never repeats the tour once seen on this device", () => {
    expect(resolveEntry({ session: "none", profileOnboarded: null, introSeenHint: true })).toBe("/app/reconnect");
  });

  it("sends expired sessions to the short reconnect screen, even without a local hint", () => {
    expect(resolveEntry({ session: "expired", profileOnboarded: true, introSeenHint: false })).toBe("/app/reconnect");
  });

  it("takes onboarded authenticated users straight home regardless of local storage", () => {
    expect(resolveEntry({ session: "valid", profileOnboarded: true, introSeenHint: false })).toBe("/app/home");
  });

  it("asks authenticated users without a completed profile for their name, skipping the tour", () => {
    expect(resolveEntry({ session: "valid", profileOnboarded: false, introSeenHint: false })).toBe("/app/setup/name");
  });
});

describe("transfer status presentation", () => {
  it("maps every backend status to a stage", () => {
    for (const status of TRANSFER_STATUSES) expect(STAGE_OF[status]).toBeDefined();
  });

  it("only labels DELIVERED as delivered", () => {
    for (const status of TRANSFER_STATUSES) {
      const delivered = pillLabel(status) === "Delivered";
      expect(delivered).toBe(status === "DELIVERED");
      const finalStep = timelineFor(status).at(-1);
      expect(finalStep?.state === "done").toBe(status === "DELIVERED");
    }
  });

  it("never labels an unresolved outcome as failed or approved", () => {
    expect(pillLabel("OUTCOME_UNKNOWN")).toBe("Checking your payment");
    expect(pillLabel("RECONCILING")).toBe("Checking your payment");
    expect(pillLabel("REFUNDED")).toBe("Not delivered — Polygon lock refunded");
    expect(matchesFilter("REFUNDED", "progress")).toBe(false);
    // Unresolved outcomes leave approval itself unconfirmed (paused), never done or failed.
    expect(timelineFor("OUTCOME_UNKNOWN")[0]).toMatchObject({ label: "Approve in Nimiq Pay", state: "paused" });
    expect(timelineFor("RECONCILING")[0]?.state).toBe("paused");
    expect(timelineFor("OUTCOME_UNKNOWN")[0]?.detail).toMatch(/Do not resend/);
    expect(timelineFor("OUTCOME_UNKNOWN").slice(1).every((s) => s.state === "upcoming")).toBe(true);
    // Funding evidence is what completes approval.
    expect(timelineFor("CLIENT_FUNDED")[0]).toMatchObject({ label: "Approved in Nimiq Pay", state: "done" });
  });

  it("filters by product stage", () => {
    expect(matchesFilter("SERVER_FUNDED", "progress")).toBe(true);
    expect(matchesFilter("DELIVERED", "progress")).toBe(false);
    expect(matchesFilter("FAILED", "attention")).toBe(true);
  });
});

describe("destinations", () => {
  it("mirrors the backend route registry", () => {
    expect(DESTINATIONS.map((d) => d.routeId)).toContain("usdc-polygon");
    expect(destinationFor("usdc-polygon").label).toBe("USDC · Polygon");
  });

  it("checks EVM address shape", () => {
    expect(destinationAddressIssue("Polygon", "0x4f2a9C1e7b3D8a0F6c5E2d1B9a8C7f6E5d4C3b21")).toBeNull();
    expect(destinationAddressIssue("Polygon", "0x123")).toMatch(/Polygon address/);
    expect(destinationAddressIssue("Polygon", "")).toMatch(/Enter/);
  });
});
