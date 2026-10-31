/**
 * F8.7 — NIM card copy regression tests (pure, no DOM).
 *
 * The Home NIM card uses clean consumer language: the wallet total with no
 * technical vault explanation, "Wallet balance" instead of "Available", and
 * "Connected through Nimiq Pay" in the foot. The full breakdown
 * (basic / contract-held / verified total / coverage warnings) lives in the
 * wallet details sheet, not on the card. Contract-held NIM is never phrased
 * as proven spendable, and "no NIM yet" never appears while vault coverage
 * is incomplete.
 */
import { describe, expect, it } from "vitest";
import type { BalanceState } from "@/ui/lib/balance";
import { NIM_CARD_FOOT, NIM_CARD_LABEL, nimCardNote } from "@/ui/components/WalletCards";

const loaded = (over: Partial<Extract<BalanceState, { status: "loaded" }>> & { luna: bigint }): BalanceState => ({
  status: "loaded",
  basicLuna: over.luna,
  vaultLuna: null,
  vaultUnknown: false,
  source: "chain",
  network: "mainnet",
  ...over,
});

describe("NIM card copy (F8.7)", () => {
  it("uses consumer-friendly card chrome", () => {
    expect(NIM_CARD_LABEL).toBe("Wallet balance");
    expect(NIM_CARD_FOOT).toBe("Connected through Nimiq Pay");
  });

  it("stays silent on a plain loaded balance (no technical text on the card)", () => {
    expect(nimCardNote(loaded({ luna: 883734849n }))).toBeNull();
  });

  it("never explains vault mechanics on the card, even when vaults hold funds", () => {
    const note = nimCardNote(
      loaded({ luna: 883734849n, basicLuna: 0n, vaultLuna: 883734849n, vaultUnknown: false }),
    );
    expect(note).toBeNull();
    // Belt-and-braces: no loaded state may leak the technical vault breakdown
    // onto the card (the coverage warning itself is required honesty, not detail).
    for (const probe of [
      loaded({ luna: 1n, basicLuna: 0n, vaultLuna: 1n, vaultUnknown: false }),
      loaded({ luna: 0n, basicLuna: 0n, vaultLuna: null, vaultUnknown: true }),
      loaded({ luna: 5n, basicLuna: 5n, vaultLuna: null, vaultUnknown: true }),
    ]) {
      expect(nimCardNote(probe) ?? "").not.toMatch(/includes|contract-held|in Nimiq Pay vaults/i);
    }
  });

  it("says no-NIM-yet only for a verified zero with complete coverage", () => {
    expect(nimCardNote(loaded({ luna: 0n, basicLuna: 0n, vaultLuna: null, vaultUnknown: false }))).toBe(
      "This wallet has no NIM yet.",
    );
  });

  it("suppresses no-NIM-yet while vault coverage is incomplete", () => {
    expect(nimCardNote(loaded({ luna: 0n, basicLuna: 0n, vaultLuna: null, vaultUnknown: true }))).toBe(
      "Vault balance couldn't be fully confirmed — the total may be higher.",
    );
    expect(nimCardNote(loaded({ luna: 5n, basicLuna: 5n, vaultLuna: null, vaultUnknown: true }))).toBe(
      "Vault balance couldn't be fully confirmed — the total may be higher.",
    );
  });

  it("explains unavailable and error states without technical detail", () => {
    expect(nimCardNote({ status: "unavailable", reason: "host-outdated" })).toBe(
      "This version of Nimiq Pay can't share your balance yet.",
    );
    expect(nimCardNote({ status: "unavailable", reason: "network-mismatch" })).toBe(
      "Nimiq Pay is on a different network, so Thence won't show a balance.",
    );
    expect(nimCardNote({ status: "unavailable", reason: "not-in-host" })).toBe("Open Thence in Nimiq Pay to see your balance.");
    expect(nimCardNote({ status: "error", reason: "network" })).toBe("Couldn't reach the Nimiq network.");
    expect(nimCardNote({ status: "error", reason: "failed" })).toBe("Couldn't load your balance.");
    expect(nimCardNote({ status: "loading" })).toBeNull();
    expect(nimCardNote({ status: "disconnected" })).toBeNull();
  });
});
