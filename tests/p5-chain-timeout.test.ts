/**
 * P5 — chain read timeouts actually fire (the old helper returned the race
 * un-awaited, so `finally` cleared the timer at once and reads never timed out).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_READ_TIMEOUT_MS, setSettlementChainForTests, verifyEvmRefundEvidence, withChainTimeout, type ChainReads } from "@/lib/settlement";

afterEach(() => {
  setSettlementChainForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("P5 chain read timeouts", () => {
  it("rejects a hung read after the timeout and passes through a fast one", async () => {
    vi.useFakeTimers();
    const hung = withChainTimeout(new Promise<never>(() => undefined), "getReceipt", 1_000);
    const assertion = expect(hung).rejects.toThrow("getReceipt timed out.");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(withChainTimeout(Promise.resolve(7), "x", 1_000)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung injected RPC makes refund verification UNAVAILABLE instead of stalling", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@fixture.invalid:5432/none");
    vi.stubEnv("THENCE_EVM_RPCS_JSON", JSON.stringify({ "137": "https://fixture.invalid" }));
    const never = () => new Promise<never>(() => undefined);
    setSettlementChainForTests({ getTransaction: never, getReceipt: never, getLatestBlockNumber: never, getFinalizedBlockNumber: never, getBlockHash: never } as ChainReads);
    const pending = verifyEvmRefundEvidence({ chainId: 137, refundTxHash: `0x${"ab".repeat(32)}`, htlcAddress: `0x${"cd".repeat(20)}`, hashLock: `0x${"ef".repeat(32)}` });
    await vi.advanceTimersByTimeAsync(CHAIN_READ_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });
});
