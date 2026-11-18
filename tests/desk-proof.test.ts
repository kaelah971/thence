import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { deriveNimiqAddress, toUserFriendlyAddress, normalizeNimiqAddress, nimiqBase32Decode } from "@/lib/nimiq";
import { findDeskDepositHashes, serializeNimiqTransactionContent, setNimiqSourceRpcTransportForTests, verifyDeskNimPayment } from "@/lib/nimiq-source";
import { validateDeskRate } from "@/lib/desk/price";

const owner = toUserFriendlyAddress(Buffer.alloc(20, 1));
const receiver = "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ";
const hash = "aa".repeat(32), now = Date.now(), memo = "THENCE:D:test-order";
const input = { txHash: hash, ownerAddress: owner, recipientAddress: receiver, amountLuna: "123456", memo, earliestMs: now - 10000, config: { url: "https://nim.test", network: "mainnet" as const, minConfirmations: 10 } };
function tx(overrides: Record<string, unknown> = {}) {
  return { hash, from: owner, fromType: 0, to: receiver, toType: 0, value: "123456", fee: "0", recipientData: Buffer.from(memo).toString("hex"), senderData: "", flags: 0, executionResult: true, networkId: 24, validityStartHeight: 100, blockNumber: 3456001, confirmations: 12, timestamp: now, ...overrides };
}
function rpc(overrides: Record<string, unknown> = {}, macro = true) {
  setNimiqSourceRpcTransportForTests(async (_url, body) => {
    const request = JSON.parse(body);
    if (request.method === "getTransactionByHash") return { result: { data: tx(overrides) } };
    if (request.method === "getTransactionsByAddress") return { result: { data: [tx(overrides)] } };
    return { result: { data: macro ? { type: "macro", number: 3456060, network: "MainAlbatross", justification: { round: 0, sig: { signature: { signature: "00" }, signers: [0] } } } : null } };
  });
}
afterEach(() => setNimiqSourceRpcTransportForTests(null));
describe("treasury native NIM evidence", () => {
  it("validates the collection address supplied by the operator", () => expect(normalizeNimiqAddress(receiver)).toBe(receiver));
  it("requires exact native payment and macro finality", async () => {
    rpc(); expect(await verifyDeskNimPayment(input)).toMatchObject({ ok: true, timestampMs: now });
    rpc({}, false); expect(await verifyDeskNimPayment(input)).toMatchObject({ ok: false });
  });
  it.each([{ from: receiver }, { value: "123455" }, { to: owner }, { recipientData: "00" }, { executionResult: false }, { networkId: 5 }, { confirmations: 1 }, { timestamp: now - 20000 }, { fromType: 2, proof: "0100" }, { senderData: "01" }])("refuses altered evidence %j", async override => {
    rpc(override); expect(await verifyDeskNimPayment(input)).toMatchObject({ ok: false });
  });
  it("discovers a positive memo match and never treats another memo as evidence", async () => {
    rpc(); expect(await findDeskDepositHashes(input.config.url, receiver, memo)).toEqual([hash]);
    expect(await findDeskDepositHashes(input.config.url, receiver, "other")).toEqual([]);
  });
  it("accepts a vault HTLC deposit only when both EarlyResolve signatures authenticate the actual payment", async () => {
    const a = generateKeyPairSync("ed25519"), b = generateKeyPairSync("ed25519");
    const aPub = Buffer.from(a.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
    const bPub = Buffer.from(b.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
    const from = toUserFriendlyAddress(Buffer.alloc(20, 3));
    const content = serializeNimiqTransactionContent({ data: Buffer.from(memo), senderAddress: from, senderType: 2, recipient: nimiqBase32Decode(receiver.replaceAll(" ", "").slice(4)), recipientType: 0, value: 123456n, fee: 0n, validityStartHeight: 100, networkId: 24, flags: 0, senderData: Buffer.alloc(0) })!;
    const proof = Buffer.concat([Buffer.from([1, 0]), bPub, Buffer.from([0]), sign(null, content, b.privateKey), Buffer.from([0]), aPub, Buffer.from([0]), sign(null, content, a.privateKey)]).toString("hex");
    rpc({ from, fromType: 2, proof });
    const vaultInput = { ...input, ownerAddress: deriveNimiqAddress(aPub.toString("hex")) };
    expect(await verifyDeskNimPayment(vaultInput)).toMatchObject({ ok: true });
    rpc({ from, fromType: 2, proof, value: "123457" });
    expect(await verifyDeskNimPayment({ ...vaultInput, amountLuna: "123457" })).toMatchObject({ ok: false, code: "WRONG_SENDER" });
  });
});
describe("separate desk pricing", () => {
  const time = Math.floor(now / 1000);
  const price = { "nimiq-2": { usd: 0.001, last_updated_at: time }, "usd-coin": { usd: 1, last_updated_at: time } };
  it("quotes a fresh NIM/USDC rate", () => expect(validateDeskRate(price, now).rateE18).toBe(1000000000000000n));
  it.each([null, {}, { ...price, "nimiq-2": { usd: 0.001, last_updated_at: time - 301 } }, { ...price, "usd-coin": { usd: 0.9, last_updated_at: time } }, { ...price, "nimiq-2": { usd: Infinity, last_updated_at: time } }])("refuses missing, stale or depegged pricing", value => expect(() => validateDeskRate(value, now)).toThrow());
});
