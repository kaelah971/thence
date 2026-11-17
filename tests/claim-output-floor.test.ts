/**
 * Output floor policy (src/domain/claim-deadline.ts) and its preview
 * (src/ui/lib/claim-output-preview.ts). Evidence-based values:
 * - 297000 / 300000 = 99%: Satora's minAmountOut in every Thence Polygon delivery.
 * - 296150 and 295446 / 300000 = 98.72% and 98.48%: Satora's DEX estimates for
 *   the f1ca0926 Arbitrum swap (price drift after the quote).
 */
import { describe, expect, it, vi } from "vitest";
import { outputFloorDecision, requiredClaimMinimum } from "@/domain/claim-deadline";
import { previewClaimOutput, usdcDisplay } from "@/ui/lib/claim-output-preview";

const R = 300_000n;

describe("output floor policy", () => {
  it.each([
    [300_000n, "auto"], [300_542n, "auto"], [297_000n, "auto"],
    [296_999n, "consent"], [296_150n, "consent"], [295_446n, "consent"], [291_000n, "consent"],
    [290_999n, "refuse"], [150_000n, "refuse"], [1n, "refuse"], [0n, "refuse"],
  ] as const)("minimum %s of 300000 → %s", (minimum, decision) => {
    expect(outputFloorDecision(R, minimum)).toBe(decision);
  });

  it("without acceptance the guard requires the automatic 99% floor", () => {
    expect(requiredClaimMinimum(R)).toBe(297_000n);
    expect(requiredClaimMinimum(R, null)).toBe(297_000n);
  });

  it("an accepted minimum binds the claim to that amount (0.25% re-quote tolerance), never below 97%", () => {
    expect(requiredClaimMinimum(R, 296_150n)).toBe(295_400n);
    expect(requiredClaimMinimum(R, 291_000n)).toBe(291_000n);
    expect(requiredClaimMinimum(R, 291_200n)).toBe(291_000n);
  });

  it("an invalid acceptance (below 97%) is ignored: the strict 99% floor applies", () => {
    expect(requiredClaimMinimum(R, 290_999n)).toBe(297_000n);
    expect(requiredClaimMinimum(R, 1n)).toBe(297_000n);
  });

  it("an acceptance above the automatic floor never raises the requirement past 99%", () => {
    expect(requiredClaimMinimum(R, 300_000n)).toBe(297_000n);
  });

  it("formats 6-decimal USDC for display", () => {
    expect(usdcDisplay("300000")).toBe("0.30");
    expect(usdcDisplay("296150")).toBe("0.29615");
    expect(usdcDisplay("2500000")).toBe("2.50");
  });
});

describe("output floor preview (same public endpoints the SDK uses)", () => {
  const DEST = "0x15451254A70e5bD6FEcA12447c42DCc9B26f3947";
  const swap = (chain: number) => ({
    id: "s1", evm_chain_id: chain, wbtc_address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", evm_expected_sats: "4640216898491",
    evm_coordinator_address: "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0",
    target_token: { token_id: chain === 137 ? "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" : "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  });
  const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  it("Arbitrum: reads the DEX estimate exactly as the SDK requests it", async () => {
    const fetchFn = vi.fn((url: string, init?: { method?: string; body?: string }) => (url.endsWith("/swap/s1") ? ok(swap(42161)) : ok({ estimated_amount_out: "296150" })));
    const r = await previewClaimOutput({ satoraSwapId: "s1", requestedAtomic: "300000", destination: DEST }, fetchFn as never, "https://p");
    expect(r).toEqual({ ok: true, preview: { requestedAtomic: "300000", minimumOutAtomic: "296150", decision: "consent" } });
    const [, init] = fetchFn.mock.calls[1]!;
    expect(fetchFn.mock.calls[1]![0]).toBe("https://p/dex-calldata/fund");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: { kind: "evm", chain_id: 42161, address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40" },
      to: { kind: "evm", chain_id: 42161, address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
      amount: { kind: "exact_in", value: "4640216898491" }, sender: "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0", slippage_bps: 100,
    });
  });

  it("Polygon: reads min_amount_out from the redeem calldata for the recipient", async () => {
    const fetchFn = vi.fn((url: string) => (url.endsWith("/swap/s1") ? ok(swap(137)) : ok({ min_amount_out: "297000" })));
    const r = await previewClaimOutput({ satoraSwapId: "s1", requestedAtomic: "300000", destination: DEST }, fetchFn as never, "https://p");
    expect(r).toMatchObject({ ok: true, preview: { minimumOutAtomic: "297000", decision: "auto" } });
    expect(fetchFn.mock.calls[1]![0]).toBe(`https://p/swap/s1/redeem-and-swap-calldata?destination=${encodeURIComponent(DEST)}`);
  });

  it("an unavailable or malformed provider never yields a decision (the strict guard then applies)", async () => {
    expect(await previewClaimOutput({ satoraSwapId: "s1", requestedAtomic: "300000", destination: DEST }, (() => Promise.reject(new Error("down"))) as never, "https://p")).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    const malformed = vi.fn((url: string) => (url.endsWith("/swap/s1") ? ok(swap(137)) : ok({ min_amount_out: "-5" })));
    expect(await previewClaimOutput({ satoraSwapId: "s1", requestedAtomic: "300000", destination: DEST }, malformed as never, "https://p")).toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
    const noTerms = vi.fn(() => ok({ id: "s1" }));
    expect(await previewClaimOutput({ satoraSwapId: "s1", requestedAtomic: "300000", destination: DEST }, noTerms as never, "https://p")).toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
  });
});
