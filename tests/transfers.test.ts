import { describe, expect, it } from "vitest";
import {
  TRANSFER_STATUSES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  transition,
} from "@/domain/transfers";

describe("transfer transition policy (B0 — PRD §9)", () => {
  it("unknown outcomes never become automatic failures", () => {
    expect(canTransition("OUTCOME_UNKNOWN", "FAILED")).toBe(false);
    expect(canTransition("OUTCOME_UNKNOWN", "DELIVERED")).toBe(false);
    expect(canTransition("OUTCOME_UNKNOWN", "NEEDS_ATTENTION")).toBe(false);
    // The ONLY legal edge out of OUTCOME_UNKNOWN is RECONCILING.
    expect([...TRANSITIONS["OUTCOME_UNKNOWN"]]).toEqual(["RECONCILING"]);
    expect(() => transition("OUTCOME_UNKNOWN", "FAILED")).toThrow(/Illegal transfer transition/);
  });

  it("delivered requires verified destination evidence", () => {
    expect(canTransition("CLAIMING", "DELIVERED")).toBe(true); // edge exists…
    expect(() => transition("CLAIMING", "DELIVERED", { evidence: {} })).toThrow(
      /destination evidence/,
    );
    expect(() =>
      transition("CLAIMING", "DELIVERED", {
        evidence: { destinationTxHash: "0xabc", amountVerified: false },
      }),
    ).toThrow(/amount verification/);
    expect(
      transition("CLAIMING", "DELIVERED", {
        evidence: { destinationTxHash: "0xabc", amountVerified: true, swapId: "swap_1" },
      }),
    ).toBe("DELIVERED");
    // No shortcut to DELIVERED from ambiguous states.
    expect(canTransition("OUTCOME_UNKNOWN", "DELIVERED")).toBe(false);
    expect(canTransition("RECONCILING", "DELIVERED")).toBe(false);
  });

  it("single-handoff: no re-entry into LIGHTNING_HANDOFF", () => {
    const inbound = (Object.entries(TRANSITIONS) as [string, readonly string[]][]).filter(([, tos]) =>
      (tos as readonly string[]).includes("LIGHTNING_HANDOFF"),
    );
    expect(inbound.map(([from]) => from)).toEqual(["AWAITING_NIM_APPROVAL"]);
    expect(canTransition("LIGHTNING_HANDOFF", "LIGHTNING_HANDOFF")).toBe(false);
  });

  it("stale quotes cannot be silently reused", () => {
    expect(isTerminal("QUOTE_EXPIRED")).toBe(true);
    expect(canTransition("QUOTE_EXPIRED", "SWAP_CREATED")).toBe(false);
    expect(canTransition("QUOTE_EXPIRED", "QUOTED")).toBe(false);
  });

  it("terminal states have no outgoing edges", () => {
    for (const s of ["QUOTE_EXPIRED", "USER_CANCELLED", "REFUNDED", "DELIVERED", "FAILED"] as const) {
      expect(TRANSITIONS[s]).toEqual([]);
      expect(isTerminal(s)).toBe(true);
    }
  });

  it("happy-path chain is legal", () => {
    const chain = [
      ["DRAFT", "QUOTED"],
      ["QUOTED", "SWAP_CREATED"],
      ["SWAP_CREATED", "AWAITING_NIM_APPROVAL"],
      ["AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF"],
      ["LIGHTNING_HANDOFF", "CLIENT_FUNDED"],
      ["CLIENT_FUNDED", "SERVER_FUNDED"],
      ["SERVER_FUNDED", "CLAIMING"],
    ] as const;
    for (const [from, to] of chain) expect(canTransition(from, to)).toBe(true);
    expect(TRANSFER_STATUSES.length).toBeGreaterThan(0);
  });
});
