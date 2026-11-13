/**
 * Simulated Nimiq Albatross chain for R2 (NIM HTLC return) tests.
 *
 * Builds cryptographically genuine fixtures: HTLC funding transactions whose
 * contract address is derived exactly like Core-rs, and HTLC spends whose
 * TimeoutResolve / EarlyResolve / RegularTransfer proofs carry real Ed25519
 * signatures over the exact serialized transaction content. A JSON-RPC
 * transport simulates getTransactionByHash, getBlockByNumber (macro
 * justification), getTransactionsByAddress / getTransactionHashesByAddress
 * (named params) and getAccountByAddress, with fault injection for
 * incomplete, disagreeing, unavailable or non-final evidence.
 *
 * No network, wallet, swap, payment or refund is involved anywhere.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { buildSignPayload, deriveNimiqAddress, nimiqBase32Decode, sha256 } from "@/lib/nimiq";
import { deriveNimiqHtlcCreationAddress, serializeNimiqTransactionContent } from "@/lib/nimiq-source";

export const GENESIS = 3_456_000;
export const macroFor = (block: number): number => block + (60 - ((block - GENESIS) % 60));

export interface Keypair {
  publicKeyHex: string;
  publicKey: Buffer;
  address: string;
  signRaw: (content: Uint8Array) => Buffer;
  /** Login-compatible signer (same shape as tests/helpers fixtureWallet). */
  signMessage: (message: string) => string;
}

export function keypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const key = createPrivateKey({ key: privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "pkcs8" });
  const publicKeyHex = raw.toString("hex");
  return {
    publicKeyHex,
    publicKey: raw,
    address: deriveNimiqAddress(publicKeyHex),
    signRaw: (content) => sign(null, Buffer.from(content), key),
    signMessage: (message) => sign(null, sha256(buildSignPayload(message)), key).toString("hex"),
  };
}

export const addrBytes = (address: string): Buffer => Buffer.from(nimiqBase32Decode(address.replace(/ /g, "").slice(4)));
export const txHash = (seed: string): string => createHash("sha256").update(`r2-${seed}`).digest("hex");

/** Simple Ed25519 SignatureProof: [algo 0][pubkey 32][merkle len 0][sig 64]. */
function signatureProof(signer: Keypair, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0]), signer.publicKey, Buffer.from([0]), signer.signRaw(content)]);
}

export interface Funding {
  tx: Record<string, unknown>;
  htlcAddress: string;
  lockedLuna: bigint;
  timeoutMs: bigint;
}

/** Native NIM HTLC creation from the owner's basic account, hash-locked to `hashLock`. */
export function buildFunding(input: {
  owner: Keypair;
  htlcRecipient: string;
  hashLock: string;
  hash: string;
  valueLuna?: bigint;
  feeLuna?: bigint;
  timeoutMs?: bigint;
  block?: number;
}): Funding {
  const value = input.valueLuna ?? 724_409_383n;
  const fee = input.feeLuna ?? 0n;
  const timeoutMs = input.timeoutMs ?? 1_794_769_370_000n;
  const data = Buffer.alloc(82);
  addrBytes(input.owner.address).copy(data, 0);
  addrBytes(input.htlcRecipient).copy(data, 20);
  data[40] = 3;
  Buffer.from(input.hashLock.replace(/^0x/, ""), "hex").copy(data, 41);
  data[73] = 1;
  data.writeBigUInt64BE(timeoutMs, 74);
  const htlcAddress = deriveNimiqHtlcCreationAddress({
    data, senderAddress: input.owner.address, senderType: 0, recipientType: 2, value, fee,
    validityStartHeight: 100, networkId: 24, flags: 1, senderData: new Uint8Array(0),
  })!;
  return {
    htlcAddress,
    lockedLuna: value,
    timeoutMs,
    tx: {
      hash: input.hash, blockNumber: input.block ?? 3_456_001, confirmations: 12, from: input.owner.address, fromType: 0,
      to: htlcAddress, toType: 2, value: value.toString(), fee: fee.toString(), recipientData: data.toString("hex"),
      senderData: "", flags: 1, executionResult: true, networkId: 24, validityStartHeight: 100, timestamp: 1_794_557_031_455,
    },
  };
}

export type SpendKind = "timeout" | "early" | "redeem";

/** An outgoing HTLC transaction with a genuine proof of the requested kind. */
export function buildSpend(input: {
  funding: Funding;
  hash: string;
  kind: SpendKind;
  to: string;
  owner: Keypair;
  recipient?: Keypair;
  /** Signs instead of the owner (invalid-proof cases). */
  signer?: Keypair;
  valueLuna?: bigint;
  feeLuna?: bigint;
  block?: number;
  timestampMs?: bigint;
  executionResult?: boolean;
}): Record<string, unknown> {
  const fee = input.feeLuna ?? 100n;
  const value = input.valueLuna ?? input.funding.lockedLuna - fee;
  const content = serializeNimiqTransactionContent({
    data: new Uint8Array(0), senderAddress: input.funding.htlcAddress, senderType: 2, recipient: addrBytes(input.to),
    recipientType: 0, value, fee, validityStartHeight: 3_456_120, networkId: 24, flags: 0, senderData: new Uint8Array(0),
  })!;
  const ownerSigner = input.signer ?? input.owner;
  let proof: Buffer;
  if (input.kind === "timeout") {
    proof = Buffer.concat([Buffer.from([2]), signatureProof(ownerSigner, content)]);
  } else if (input.kind === "early") {
    proof = Buffer.concat([Buffer.from([1]), signatureProof(input.recipient!, content), signatureProof(ownerSigner, content)]);
  } else {
    // RegularTransfer: [0][algo][depth][root 32][preimage 32][recipient sig] — only the discriminant matters.
    proof = Buffer.concat([Buffer.from([0, 3, 1]), Buffer.alloc(64, 7), signatureProof(input.recipient ?? ownerSigner, content)]);
  }
  return {
    hash: input.hash, blockNumber: input.block ?? 3_456_130, confirmations: 12, from: input.funding.htlcAddress, fromType: 2,
    to: input.to, toType: 0, value: value.toString(), fee: fee.toString(), recipientData: "", senderData: "", flags: 0,
    executionResult: input.executionResult ?? true, networkId: 24, validityStartHeight: 3_456_120,
    timestamp: Number(input.timestampMs ?? input.funding.timeoutMs + 60_000n), proof: proof.toString("hex"),
  };
}

/** Mutable simulated node. Every fault is opt-in per test. */
export class SimulatedNimiqNode {
  txs = new Map<string, Record<string, unknown>>();
  finalMacros = new Set<number>();
  /** Address → ordered tx hashes (both endpoints read this unless overridden). */
  history = new Map<string, string[]>();
  balances = new Map<string, bigint>();
  down = false;
  /** Make getTransactionHashesByAddress return a different set. */
  hashesOverride: string[] | null = null;
  /** Pretend the node returns exactly `max` items (possible truncation). */
  truncate = false;
  calls: Array<{ method: string; params: unknown }> = [];

  addTx(tx: Record<string, unknown>, opts: { final?: boolean | undefined } = {}): void {
    const hash = String(tx["hash"]);
    this.txs.set(hash, tx);
    for (const addr of [String(tx["from"]), String(tx["to"])]) {
      const list = this.history.get(addr) ?? [];
      if (!list.includes(hash)) list.push(hash);
      this.history.set(addr, list);
    }
    if (opts.final !== false) this.finalMacros.add(macroFor(Number(tx["blockNumber"])));
  }

  transport = async (_url: string, body: string): Promise<unknown> => {
    const req = JSON.parse(body) as { method: string; params: unknown };
    this.calls.push(req);
    if (this.down) throw new Error("node down");
    const ok = (data: unknown) => ({ jsonrpc: "2.0", id: 1, result: { data, metadata: null } });
    const positional = Array.isArray(req.params) ? (req.params as unknown[]) : [];
    const named = !Array.isArray(req.params) && req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
    switch (req.method) {
      case "getTransactionByHash": {
        const tx = this.txs.get(String(positional[0]));
        if (!tx) return { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: `Transaction not found: ${String(positional[0])}` } };
        return ok(tx);
      }
      case "getBlockByNumber": {
        const n = Number(positional[0]);
        return ok(this.finalMacros.has(n) ? { type: "macro", number: n, network: "MainAlbatross", justification: { round: 0, sig: { signature: { signature: "00" }, signers: [0] } } } : null);
      }
      case "getTransactionsByAddress":
      case "getTransactionHashesByAddress": {
        if (!("address" in named)) return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } };
        const max = Number(named["max"]);
        let hashes = [...(this.history.get(String(named["address"])) ?? [])];
        if (req.method === "getTransactionHashesByAddress" && this.hashesOverride) hashes = [...this.hashesOverride];
        if (this.truncate) while (hashes.length < max) hashes.push(txHash(`filler-${hashes.length}`));
        if (req.method === "getTransactionHashesByAddress") return ok(hashes);
        return ok(hashes.map((h) => this.txs.get(h) ?? { hash: h, from: "NQ00 0000 0000 0000 0000 0000 0000 0000 0000", to: String(named["address"]) }));
      }
      case "getAccountByAddress": {
        const addr = String(positional[0]);
        return ok({ address: addr, balance: Number(this.balances.get(addr) ?? 0n), type: this.balances.get(addr) ? "htlc" : "basic" });
      }
      default:
        return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
    }
  };
}
