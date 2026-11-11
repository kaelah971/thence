import { afterEach, describe, expect, it } from "vitest";
import { toUserFriendlyAddress } from "@/lib/nimiq";
import {
  isNimiqSourceHashUnattributed,
  selectUnambiguousHistoricalNimiqSourceHash,
  setNimiqSourceRpcTransportForTests,
  verifyNimiqSourceTransaction,
  type NimiqSourceVerificationInput,
} from "@/lib/nimiq-source";

const TX_HASH = "11".repeat(32);
const PAYMENT_HASH = "aa".repeat(32);
const OWNER_BYTES = Buffer.from("00112233445566778899aabbccddeeff00112233", "hex");
const HTLC_RECIPIENT_BYTES = Buffer.from("33445566778899aabbccddeeff00112233445566", "hex");
const REMOTE_HTLC_BYTES = Buffer.from("66778899aabbccddeeff00112233445566778899", "hex");
const OWNER = toUserFriendlyAddress(OWNER_BYTES);
const HTLC_RECIPIENT = toUserFriendlyAddress(HTLC_RECIPIENT_BYTES);
const REMOTE_HTLC = toUserFriendlyAddress(REMOTE_HTLC_BYTES);
const VALIDITY_START_HEIGHT = 100;
const NETWORK_ID = 24;
const TRANSACTION_BLOCK = 3_456_001;
const FINALIZING_MACRO_BLOCK = 3_456_060;

function htlcData(overrides: { owner?: Buffer; paymentHash?: string; hashCount?: number; algorithm?: number; timeout?: number } = {}): string {
  const bytes = Buffer.alloc(78);
  (overrides.owner ?? OWNER_BYTES).copy(bytes, 0);
  HTLC_RECIPIENT_BYTES.copy(bytes, 20);
  bytes[40] = overrides.algorithm ?? 3;
  Buffer.from(overrides.paymentHash ?? PAYMENT_HASH, "hex").copy(bytes, 41);
  bytes[73] = overrides.hashCount ?? 1;
  bytes.writeUInt32BE(overrides.timeout ?? 1_900_000_000, 74);
  return bytes.toString("hex");
}

// Independently computed from core-rs Transaction::contract_creation_address
// for the fixture's serialized transaction content.
const HTLC_CREATION_RECIPIENT = "NQ36 05JD PM42 JRYV X8RG 3D7G Q9F0 0SR3 RTC1";

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: TX_HASH,
    blockNumber: TRANSACTION_BLOCK,
    confirmations: 12,
    from: OWNER,
    fromType: 0,
    to: HTLC_CREATION_RECIPIENT,
    toType: 2,
    value: "100000",
    fee: "100",
    recipientData: htlcData(),
    flags: 1,
    executionResult: true,
    networkId: NETWORK_ID,
    validityStartHeight: VALIDITY_START_HEIGHT,
    ...overrides,
  };
}

function input(overrides: Partial<NimiqSourceVerificationInput> = {}): NimiqSourceVerificationInput {
  return {
    txHash: TX_HASH,
    ownerAddress: OWNER,
    lightningPaymentHash: PAYMENT_HASH,
    config: { url: "https://nim.test/rpc", network: "mainnet", minConfirmations: 6 },
    ...overrides,
  };
}

function macroBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "macro",
    number: FINALIZING_MACRO_BLOCK,
    network: "MainAlbatross",
    justification: { round: 0, sig: { signature: { signature: "00" }, signers: [0] } },
    ...overrides,
  };
}

function stubTransaction(tx: Record<string, unknown>, macro: Record<string, unknown> | null = macroBlock()): void {
  setNimiqSourceRpcTransportForTests(async (_url, body) => {
    const request = JSON.parse(body) as { method: string; params?: unknown[] };
    if (request.method === "getTransactionByHash") {
      expect(request.params).toEqual([TX_HASH]);
      return { jsonrpc: "2.0", id: 1, result: { data: tx } };
    }
    expect(request.method).toBe("getBlockByNumber");
    expect(request.params).toEqual([FINALIZING_MACRO_BLOCK, false]);
    return { jsonrpc: "2.0", id: 1, result: { data: macro } };
  });
}

afterEach(() => setNimiqSourceRpcTransportForTests(null));

describe("independent Nimiq source verification", () => {
  it("refuses duplicate attribution and ambiguous historical candidates", () => {
    const hash = "11".repeat(32);
    expect(isNimiqSourceHashUnattributed(hash, "transfer-a", [])).toBe(true);
    expect(isNimiqSourceHashUnattributed(hash, "transfer-b", [{ transferId: "transfer-a", transactionHash: `0x${hash}` }])).toBe(false);
    expect(isNimiqSourceHashUnattributed(hash, "transfer-a", [{ transferId: "transfer-a", transactionHash: hash }])).toBe(true);
    expect(selectUnambiguousHistoricalNimiqSourceHash([hash])).toBe(hash);
    expect(selectUnambiguousHistoricalNimiqSourceHash([hash, `0x${hash}`])).toBe(hash);
    expect(selectUnambiguousHistoricalNimiqSourceHash([])).toBeNull();
    expect(selectUnambiguousHistoricalNimiqSourceHash([hash, "22".repeat(32)])).toBeNull();
    expect(selectUnambiguousHistoricalNimiqSourceHash(["not-a-hash"])).toBeNull();
  });

  it("proves a successful native NIM HTLC funding transaction", async () => {
    stubTransaction(transaction());
    await expect(verifyNimiqSourceTransaction(input())).resolves.toMatchObject({
      ok: true,
      evidence: {
        asset: "NIM",
        transactionHash: TX_HASH,
        senderAddress: OWNER,
        ownerAddress: OWNER,
        amountLuna: "100000",
        feeLuna: "100",
        totalDebitLuna: "100100",
        blockNumber: TRANSACTION_BLOCK,
        confirmations: 12,
        finalizedByMacroBlock: FINALIZING_MACRO_BLOCK,
        network: "mainnet",
        lightningPaymentHash: PAYMENT_HASH,
        htlcRecipient: HTLC_RECIPIENT,
        htlcTimeout: "1900000000",
      },
    });
  });

  it.each([
    [{ executionResult: false }, "UNSUCCESSFUL"],
    [{ networkId: 5 }, "WRONG_NETWORK"],
    [{ confirmations: 2 }, "INSUFFICIENT_FINALITY"],
    [{ value: "0" }, "INVALID_AMOUNT"],
    [{ flags: 0 }, "WRONG_ASSET"],
    [{ toType: 0 }, "WRONG_ASSET"],
    [{ recipientData: htlcData({ algorithm: 1 }) }, "WRONG_ASSET"],
    [{ from: REMOTE_HTLC }, "WRONG_SENDER"],
    [{ recipientData: htlcData({ owner: HTLC_RECIPIENT_BYTES }) }, "WRONG_SENDER"],
    [{ to: toUserFriendlyAddress(Buffer.alloc(20)) }, "WRONG_ASSET"],
    [{ recipientData: htlcData({ paymentHash: "bb".repeat(32) }) }, "PAYMENT_HASH_MISMATCH"],
    [{ hash: "22".repeat(32) }, "HASH_MISMATCH"],
  ] as const)("rejects independently unverifiable source evidence (%s)", async (overrides, code) => {
    stubTransaction(transaction(overrides));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code });
  });

  it("rejects a missing contract-creation identity field instead of guessing", async () => {
    stubTransaction(transaction({ validityStartHeight: undefined }));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
  });

  it("rejects an explicit source amount mismatch instead of guessing", async () => {
    stubTransaction(transaction());
    await expect(verifyNimiqSourceTransaction(input({ expectedAmountLuna: "100001" }))).resolves.toEqual({ ok: false, code: "AMOUNT_MISMATCH" });
  });

  it("requires a justified macro block instead of treating confirmations as finality", async () => {
    stubTransaction(transaction(), null);
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "INSUFFICIENT_FINALITY" });

    stubTransaction(transaction(), macroBlock({ type: "micro" }));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_MALFORMED" });

    stubTransaction(transaction(), macroBlock({ justification: { round: 0, sig: { signature: {}, signers: [] } } }));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
  });

  it("fails closed when the finalizing macro block is on the wrong network", async () => {
    stubTransaction(transaction(), macroBlock({ network: "TestAlbatross" }));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
  });

  it("rejects missing proof configuration without touching the network", async () => {
    let called = false;
    setNimiqSourceRpcTransportForTests(async () => {
      called = true;
      return {};
    });
    await expect(verifyNimiqSourceTransaction(input({ config: { url: "", network: "mainnet", minConfirmations: 1 } }))).resolves.toEqual({ ok: false, code: "NOT_CONFIGURED" });
    expect(called).toBe(false);
  });

  it("fails closed on unavailable or malformed RPC responses", async () => {
    setNimiqSourceRpcTransportForTests(async () => {
      throw new Error("offline");
    });
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });

    setNimiqSourceRpcTransportForTests(async () => ({ jsonrpc: "2.0", id: 1, result: { data: { nope: true } } }));
    await expect(verifyNimiqSourceTransaction(input())).resolves.toEqual({ ok: false, code: "PROVIDER_MALFORMED" });
  });
});
