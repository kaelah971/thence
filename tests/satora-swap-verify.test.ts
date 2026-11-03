/**
 * P0 — provider swap verification follows the Satora response schema
 * (mocked I/O only).
 *
 * Production attach failed every swap with PROVIDER_MALFORMED because
 * getProviderSwap read token identity from `target_token.address` /
 * `target_token.chain_id`, which do not exist in the provider schema
 * (TokenInfo carries `token_id` + `chain`; the numeric id echoes as
 * `evm_chain_id`). The direction discriminator is tolerated when absent
 * while a contradicting one still rejects.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getProviderSwap, setSatoraFetchersForTests, type VerifiedSwapFacts } from "@/lib/satora";
import { AuthError } from "@/lib/auth";
import { verifySwapMatch } from "@/lib/handoff";

afterEach(() => {
  setSatoraFetchersForTests(null);
});

const TOKEN = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const DEST = "0x0000000000000000000000000000000000000001";

// Schema-true LightningToEvmSwapResponse fragment: token identity lives in
// target_token.token_id + evm_chain_id. No address/chain_id anywhere.
function swapResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "swap-1",
    direction: "lightning_to_evm",
    bolt11_invoice: "lnbc3930n1psomeinvoice",
    hash_lock: `0x${"ab".repeat(32)}`,
    source_amount: "393",
    target_amount: "300000",
    evm_chain_id: 137,
    target_evm_address: DEST,
    target_token: { chain: "137", decimals: 6, name: "USD Coin", symbol: "USDC", token_id: TOKEN },
    status: "pending",
    invoice_expires_at: Math.floor(Date.now() / 1000) + 3600,
    fee_sats: 5,
    ...over,
  };
}

function facts(over: Partial<VerifiedSwapFacts> = {}): VerifiedSwapFacts {
  return {
    satoraSwapId: "swap-1",
    direction: "lightning_to_evm",
    bolt11Invoice: "lnbc3930n1psomeinvoice",
    paymentHash: `0x${"ab".repeat(32)}`,
    sourceSats: "393",
    targetAtomic: "300000",
    evmChainId: 137,
    targetAddress: DEST,
    targetTokenAddress: TOKEN,
    targetTokenChainId: 137,
    status: "pending",
    invoiceExpiresAt: new Date(Date.now() + 3600_000),
    feeSats: 5,
    evmHtlcAddress: null,
    evmFundTxid: null,
    evmClaimTxid: null,
    ...over,
  };
}

describe("getProviderSwap resolves token identity from the real schema", () => {
  it("parses a schema-true swap (no address/chain_id fields)", async () => {
    setSatoraFetchersForTests({ getSwap: async () => swapResponse() });
    const parsed = await getProviderSwap("swap-1");
    expect(parsed.satoraSwapId).toBe("swap-1");
    expect(parsed.targetTokenAddress).toBe(TOKEN);
    expect(parsed.targetTokenChainId).toBe(137);
    expect(parsed.evmChainId).toBe(137);
    expect(parsed.targetAddress).toBe(DEST);
  });

  it("still rejects a swap with no token identity", async () => {
    setSatoraFetchersForTests({ getSwap: async () => swapResponse({ target_token: null }) });
    await expect(getProviderSwap("swap-1")).rejects.toMatchObject({ name: "SatoraError", code: "PROVIDER_MALFORMED" });
  });

  it("still rejects a btc-only token identity for an EVM route", async () => {
    setSatoraFetchersForTests({
      getSwap: async () => swapResponse({ target_token: { chain: "137", decimals: 6, name: "X", symbol: "X", token_id: "btc" } }),
    });
    await expect(getProviderSwap("swap-1")).rejects.toMatchObject({ code: "PROVIDER_MALFORMED" });
  });
});

describe("verifySwapMatch pins the swap without requiring direction", () => {
  const args = {
    asset: "USDC",
    network: "Polygon",
    chainId: "137",
    tokenAddress: TOKEN,
    destination: DEST,
    targetAmountAtomic: "300000",
  } as const;

  it("accepts a schema-true match", () => {
    expect(() => verifySwapMatch({ ...args, swap: facts() })).not.toThrow();
  });

  it("still rejects an absent direction discriminator", () => {
    try {
      verifySwapMatch({ ...args, swap: facts({ direction: "" }) });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("SWAP_MISMATCH");
    }
  });

  it("rejects a contradicting direction", () => {
    try {
      verifySwapMatch({ ...args, swap: facts({ direction: "evm_to_lightning" }) });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("SWAP_MISMATCH");
    }
  });

  it("rejects chain, token, destination and amount mismatches", () => {
    const cases: Array<Partial<VerifiedSwapFacts>> = [
      { evmChainId: 1 },
      { targetTokenAddress: "0x0000000000000000000000000000000000000002" },
      { targetAddress: "0x0000000000000000000000000000000000000002" },
      { targetAtomic: "300001" },
    ];
    for (const over of cases) {
      try {
        verifySwapMatch({ ...args, swap: facts(over) });
        expect.unreachable(`must throw for ${JSON.stringify(over)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
      }
    }
  });
});
