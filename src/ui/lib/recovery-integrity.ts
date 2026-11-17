import { bech32 } from "@scure/base";
import { sha256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const hex32 = (value: unknown): Hex | null => typeof value === "string" && /^(?:0x)?[a-fA-F0-9]{64}$/.test(value) ? `0x${value.replace(/^0x/, "").toLowerCase()}` : null;

export function invoiceMatchesPayment(invoice: unknown, hash: unknown, sourceSats: unknown): boolean {
  if (typeof invoice !== "string" || typeof sourceSats !== "string" || !/^[1-9][0-9]*$/.test(sourceSats)) return false;
  try {
    const decoded = bech32.decode(invoice as `${string}1${string}`, 10_000);
    const amount = /^lnbc([1-9][0-9]*)([munp]?)$/.exec(decoded.prefix);
    if (!amount || decoded.words.length < 111) return false;
    const units: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n, p: 1n };
    const value = BigInt(amount[1]!) * units[amount[2]!]!;
    const millisats = amount[2] === "p" ? value / 10n : value;
    if (amount[2] === "p" && value % 10n !== 0n) return false;
    if (millisats !== BigInt(sourceSats) * 1_000n) return false;
    const end = decoded.words.length - 104;
    let paymentHash: Hex | null = null;
    for (let offset = 7; offset < end;) {
      if (offset + 3 > end) return false;
      const tag = decoded.words[offset]!;
      const length = decoded.words[offset + 1]! * 32 + decoded.words[offset + 2]!;
      offset += 3;
      if (offset + length > end) return false;
      if (tag === 1) {
        if (paymentHash !== null || length !== 52) return false;
        const bytes = bech32.fromWords(decoded.words.slice(offset, offset + length));
        paymentHash = hex32(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
      }
      offset += length;
    }
    return paymentHash !== null && paymentHash === hex32(hash);
  } catch {
    return false;
  }
}

export function recoveryIntegrityProblem(stored: { preimage?: unknown; preimageHash?: unknown; secretKey?: unknown; response: unknown }, walletAddress?: string): string | null {
  const response = stored.response as Record<string, unknown> | null;
  const preimage = hex32(stored.preimage);
  const localHash = hex32(stored.preimageHash);
  const key = hex32(stored.secretKey);
  if (!response || !preimage || !localHash || !key) return "Recovery material is incomplete or malformed.";
  if (sha256(preimage) !== localHash || localHash !== hex32(response["hash_lock"])) return "Recovery material does not match the payment hash.";
  try {
    const claimAddress = response["client_evm_address"];
    const derived = privateKeyToAccount(key).address.toLowerCase();
    if (typeof claimAddress !== "string" || (claimAddress.toLowerCase() !== derived && claimAddress.toLowerCase() !== walletAddress?.toLowerCase())) return "Recovery signing identity does not match the claim address.";
  } catch {
    return "Recovery signing identity is invalid.";
  }
  if (!invoiceMatchesPayment(response["bolt11_invoice"], localHash, response["source_amount"])) return "The invoice does not match the payment hash and source amount.";
  return null;
}
