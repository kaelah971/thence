import { afterEach, describe, expect, it, vi } from "vitest";
import { invoiceMatchesPayment, recoveryIntegrityProblem } from "@/ui/lib/recovery-integrity";
import { readBackSwap, setBrowserSwapClientForTests } from "@/ui/lib/satora-browser";
import { saveHandoffRecord } from "@/ui/screens/send/useHandoff";
import { syntheticStoredSwap } from "./payment-crypto-fixture";

afterEach(() => { setBrowserSwapClientForTests(null); vi.unstubAllGlobals(); });

describe("independent recovery integrity", () => {
  it("accepts matching local cryptographic and invoice facts", () => {
    expect(recoveryIntegrityProblem(syntheticStoredSwap())).toBeNull();
  });
  it.each(["hash_lock", "client_evm_address", "source_amount", "bolt11_invoice"])("refuses a mismatched provider %s", async (field) => {
    const stored = syntheticStoredSwap({ [field]: field === "source_amount" ? "6328" : field === "bolt11_invoice" ? "lnbc1bad" : `0x${"56".repeat(field === "hash_lock" ? 32 : 20)}` });
    setBrowserSwapClientForTests({ getStoredSwap: async () => stored as never, createLightningToEvmSwap: async () => ({ response: stored.response }), claim: async () => ({ success: false, message: "unused" }) });
    expect((await readBackSwap(stored.swapId)).ok).toBe(false);
  });
  it.each(["preimage", "preimageHash", "secretKey"])("refuses corrupt local %s", (field) => {
    expect(recoveryIntegrityProblem({ ...syntheticStoredSwap(), [field]: "00".repeat(32) })).not.toBeNull();
  });
  it("permits the SDK's verified legacy wallet signing identity", () => {
    const wallet = `0x${"56".repeat(20)}`;
    expect(recoveryIntegrityProblem(syntheticStoredSwap({ client_evm_address: wallet }), wallet)).toBeNull();
    expect(recoveryIntegrityProblem(syntheticStoredSwap({ client_evm_address: wallet }))).not.toBeNull();
  });
  it("rejects checksum corruption and amountless or wrong-network invoices", () => {
    const response = syntheticStoredSwap().response;
    const invoice = response.bolt11_invoice;
    for (const bad of [invoice.slice(0, -1) + "p", invoice.replace("lnbc", "lntb"), "lnbc1bad"]) {
      expect(invoiceMatchesPayment(bad, response.hash_lock, response.source_amount)).toBe(false);
    }
  });
});

describe("native invocation requires a readable replay record", () => {
  const record = { transferId: "t-integrity", ownerUserId: "u-integrity", invoice: "synthetic", invokedAt: new Date().toISOString(), outcomeReported: false, reportedOutcome: null, sourceTxHash: null };
  it("fails closed when storage throws, drops writes, or is missing", () => {
    for (const localStorage of [undefined, { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined }, { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }]) {
      vi.stubGlobal("window", { localStorage });
      expect(saveHandoffRecord(record)).toBe(false);
    }
  });
  it("confirms the exact replay record after a successful write", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
    expect(saveHandoffRecord(record)).toBe(true);
  });
});
