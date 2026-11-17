import { bech32 } from "@scure/base";
import { hexToBytes, sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ClaimIntentView } from "@/ui/lib/settlement-client";

export function syntheticClaimIntent(swap: Record<string, unknown> = {}): ClaimIntentView {
  const token = swap["target_token"] as Record<string, unknown> | undefined;
  return {
    transferId: "t-1", status: "CLAIMING", satoraSwapId: String(swap["id"] ?? "swap-1"),
    paymentHash: String(swap["hash_lock"] ?? `0x${"ab".repeat(32)}`), destination: String(swap["target_evm_address"] ?? "0x0000000000000000000000000000000000000001"),
    targetAmountAtomic: String(swap["target_amount"] ?? "5000000"), claimDeadline: new Date(Number(swap["evm_refund_locktime"] ?? Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(), fundingConfirmations: 256, retry: false,
    htlc: {
      chainId: Number(swap["evm_chain_id"] ?? 137), htlcAddress: String(swap["evm_htlc_address"] ?? "0xf12a26a6cefc1f5a0772faf09f94c5e5662a3948"),
      version: Number(swap["evm_htlc_version"] ?? 6), kind: "erc20", coordinator: String(swap["evm_coordinator_address"] ?? "0xdb76f29f1d04d1202f56a34549869b070dfcbff0"),
      lockToken: String(swap["wbtc_address"] ?? "0x0000000000000000000000000000000000000002"), lockAmount: String(swap["evm_expected_sats"] ?? "4000"),
      refundAddress: String(swap["server_evm_address"] ?? "0x0000000000000000000000000000000000000003"), claimAddress: String(swap["client_evm_address"] ?? "0x0000000000000000000000000000000000000004"),
      targetToken: String(token?.["token_id"] ?? "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
    },
  };
}

export function syntheticInvoice(hash: Hex, sats: string): string {
  const words = [...Array<number>(7).fill(0), 1, 1, 20, ...bech32.toWords(hexToBytes(hash)), ...Array<number>(104).fill(0)];
  return bech32.encode(`lnbc${BigInt(sats) * 10n}n`, words, 10_000);
}

export function syntheticStoredSwap(overrides: Record<string, unknown> = {}) {
  const preimage = "12".repeat(32);
  const secretKey = "34".repeat(32);
  const hash = sha256(`0x${preimage}`);
  const response = {
    id: "swap-1", hash_lock: hash, source_amount: "6327", target_amount: "5000000",
    target_evm_address: "0x0000000000000000000000000000000000000001",
    client_evm_address: privateKeyToAccount(`0x${secretKey}`).address,
    bolt11_invoice: syntheticInvoice(hash, "6327"),
    evm_refund_locktime: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return { version: 3, swapId: "swap-1", keyIndex: 0, response, publicKey: "", preimage, preimageHash: hash.slice(2), secretKey, storedAt: Date.now(), updatedAt: Date.now() };
}
