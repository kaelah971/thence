/**
 * F4.1 — durable recovery vault tests (no IndexedDB required).
 * Uses the in-memory vault (same validation) + pure binding checks:
 * persistence, read-back integrity, storage failure, crash/reload,
 * corrupt/missing/incompatible/foreign material.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryVault,
  createUnavailableVault,
  validateBinding,
  type RecoveryBinding,
} from "@/ui/lib/recovery-vault";

const binding = (over: Partial<RecoveryBinding> = {}): RecoveryBinding => ({
  version: 1,
  transferId: "t-1",
  satoraSwapId: "swap-11111111-2222-3333-4444-555555555555",
  paymentHash: `0x${"ab".repeat(32)}`,
  sourceSats: "6327",
  targetAtomic: "5000000",
  destination: "0x0000000000000000000000000000000000000001",
  routeId: "usdc-polygon",
  quoteRevision: 1,
  ownerUserId: "u-1",
  attemptToken: "attempt-token-opaque",
  storedAt: new Date().toISOString(),
  verifiedAt: null,
  ...over,
});

describe("binding validation", () => {
  it("accepts a well-formed binding", () => {
    const res = validateBinding(binding(), { transferId: "t-1", ownerUserId: "u-1" });
    expect(res.status).toBe("ok");
  });

  it("reports missing material", () => {
    expect(validateBinding(null, { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("missing");
  });

  it("reports corrupt material", () => {
    expect(validateBinding({ version: 1 }, { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("corrupt");
    expect(validateBinding(binding({ targetAtomic: "0" }), { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("corrupt");
    expect(validateBinding(binding({ satoraSwapId: "" }), { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("corrupt");
    expect(validateBinding(binding({ attemptToken: "" }), { transferId: "t-1", ownerUserId: "u-1" }).status).toBe("corrupt");
  });

  it("distinguishes a binding for a different transfer", () => {
    const res = validateBinding(binding(), { transferId: "t-2", ownerUserId: "u-1" });
    expect(res.status).toBe("corrupt");
  });

  it("never leaks bindings across users", () => {
    const res = validateBinding(binding(), { transferId: "t-1", ownerUserId: "u-2" });
    expect(res.status).toBe("foreign");
  });

  it("reports incompatible schema versions", () => {
    const res = validateBinding(binding({ version: 999 }), { transferId: "t-1", ownerUserId: "u-1" });
    expect(res.status).toBe("incompatible");
  });

  it("survives a JSON round-trip (crash/reload)", () => {
    const serialized = JSON.stringify(binding());
    const res = validateBinding(JSON.parse(serialized), { transferId: "t-1", ownerUserId: "u-1" });
    expect(res.status).toBe("ok");
  });
});

describe("memory vault persistence + readback", () => {
  it("persists before proceeding and reads back intact", async () => {
    const vault = createMemoryVault();
    const saved = await vault.saveAndVerify(binding());
    expect(saved.status).toBe("ok");
    const loaded = await vault.load("t-1", "u-1");
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.binding.satoraSwapId).toBe(binding().satoraSwapId);
  });

  it("detects corrupted recovery material instead of silently discarding it", async () => {
    const vault = createMemoryVault();
    await vault.saveAndVerify(binding());
    vault.records.set("t-1", { version: 1, transferId: "t-1" });
    const loaded = await vault.load("t-1", "u-1");
    expect(loaded.status).toBe("corrupt");
    // Unresolved material is kept for explicit retry, not auto-cleared.
    expect(vault.records.has("t-1")).toBe(true);
  });

  it("reports missing material for unknown transfers", async () => {
    const vault = createMemoryVault();
    expect((await vault.load("nope", "u-1")).status).toBe("missing");
  });

  it("clears only on explicit action", async () => {
    const vault = createMemoryVault();
    await vault.saveAndVerify(binding());
    await vault.clear("t-1");
    expect((await vault.load("t-1", "u-1")).status).toBe("missing");
  });
});

describe("storage failure stops the flow safely", () => {
  it("fails closed when durable storage is unavailable", async () => {
    const vault = createUnavailableVault("Durable storage is unavailable in this browser.");
    expect(vault.available).toBe(false);
    const saved = await vault.saveAndVerify(binding());
    expect(saved.status).toBe("unavailable");
    const loaded = await vault.load("t-1", "u-1");
    expect(loaded.status).toBe("unavailable");
  });
});
