// @vitest-environment jsdom
/**
 * Pre-payment browser integrity (no network, no DB, no host, no funds).
 *
 * 1. Handoff replay guard: the record written BEFORE Nimiq Pay is called must
 *    be proven durable by readback. Failed/unavailable/silently-dropped storage
 *    must refuse the native call (otherwise a reload could pay twice).
 * 2. Satora recovery readback: the stored preimage must hash to the stored
 *    preimageHash AND the provider hash_lock; the stored secretKey must be a
 *    valid scalar whose EVM address is the swap's claim address (the SDK's
 *    #getClaimEvmSigningKey silently falls back to a wallet-level key when it
 *    is not). createExactReceiveSwap must not report success before this
 *    validation passes. All crypto here is real (sha256, secp256k1).
 *
 * Invoice amount/payment-hash decoding itself is covered by
 * tests/payment-browser-integrity.test.ts (recovery-integrity.ts).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTransfer: vi.fn(),
  fetchAttempt: vi.fn(),
  report: vi.fn(),
}));

vi.mock("@/ui/lib/prepare-flow", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/prepare-flow")>();
  return { ...original, fetchTransfer: mocks.fetchTransfer, fetchAttempt: mocks.fetchAttempt };
});
vi.mock("@/ui/lib/handoff-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/handoff-client")>();
  return { ...original, reportHandoffResult: mocks.report };
});
vi.mock("@/ui/lib/payment-gate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/ui/lib/payment-gate")>();
  // Only the deployment flag is opened; the real gate still evaluates everything else.
  return { ...original, isPaymentFlagEnabled: () => true };
});
vi.mock("@nimiq/mini-app-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@nimiq/mini-app-sdk")>();
  return { ...original, getHostNetwork: () => "mainnet" };
});

import { createMemoryVault, type RecoveryBinding } from "@/ui/lib/recovery-vault";
import type { LightningCapableProvider } from "@/ui/lib/nimiq-pay";
import { createExactReceiveSwap, readBackSwap, setBrowserSwapClientForTests } from "@/ui/lib/satora-browser";
import { loadHandoffRecord, saveHandoffRecord, useHandoff } from "@/ui/screens/send/useHandoff";
import { syntheticStoredSwap } from "./payment-crypto-fixture";

const INVOICE = "lnbc100u1p0fakeinvoicepp5fakepp5fakepp5fakepp5fakepp5fakeqdqqxqyjw5q9qy9qsq";
const ADDR = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const TRANSFER = "t-1";
const OWNER = "u-1";
const SWAP = "swap-1";

// ---------------------------------------------------------------- crypto fixtures
// Real sha256 / secp256k1 / bech32 invoice (tests/payment-crypto-fixture.ts).

const sha256Hex = (hex: string): string => sha256(`0x${hex}`).slice(2);
const PREIMAGE = "12".repeat(32);
const OTHER_PREIMAGE = "cd".repeat(32);
const SECRET = "34".repeat(32);
const OTHER_SECRET = "12".repeat(32);
const secretAddress = (key: string): string => privateKeyToAccount(`0x${key}`).address;
const HASH = sha256Hex(PREIMAGE);

function stored(over: Record<string, unknown> = {}, responseOver: Record<string, unknown> = {}) {
  return { ...syntheticStoredSwap(responseOver), ...over };
}

function sdkWith(row: unknown, created?: Record<string, unknown>, walletAddress?: string | (() => string)) {
  setBrowserSwapClientForTests({
    createLightningToEvmSwap: (async () => ({ response: created ?? {} })) as never,
    getStoredSwap: (async (id: string) => (id === SWAP ? row : null)) as never,
    claim: (async () => ({ success: false, message: "disabled" })) as never,
    ...(walletAddress ? { getEvmAddress: typeof walletAddress === "function" ? walletAddress : () => walletAddress } : {}),
  });
}

const SECRET_MARKERS = [PREIMAGE, OTHER_PREIMAGE, SECRET];
function expectNoSecretEcho(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of SECRET_MARKERS) expect(text.toLowerCase()).not.toContain(marker);
}

afterEach(() => {
  cleanup();
  setBrowserSwapClientForTests(null);
  vi.restoreAllMocks();
  delete (globalThis as { __thenceVault?: unknown }).__thenceVault;
  delete (globalThis as { __thencePayProvider?: unknown }).__thencePayProvider;
  window.localStorage.clear();
});

// ---------------------------------------------------------------- satora-browser

describe("readBackSwap validates recovery material cryptographically", () => {
  it("accepts a consistent swap (0x/uppercase forms too) and returns only public facts", async () => {
    sdkWith(stored({ preimage: `0x${PREIMAGE.toUpperCase()}` }));
    const res = await readBackSwap(SWAP);
    expect(res).toMatchObject({ ok: true, hasRecoveryMaterial: true, paymentHash: `0x${HASH}` });
    expectNoSecretEcho(res);
  });

  it("rejects a preimage that does not hash to the stored preimageHash (string-length check used to pass)", async () => {
    sdkWith(stored({ preimage: OTHER_PREIMAGE }));
    const res = await readBackSwap(SWAP);
    expect(res.ok).toBe(false);
    expect(res.hasRecoveryMaterial).toBe(false);
    expect(res.paymentHash).toBeNull();
    expectNoSecretEcho(res);
  });

  it("rejects a self-consistent preimage/preimageHash that differs from the provider hash_lock", async () => {
    sdkWith(stored({ preimage: OTHER_PREIMAGE, preimageHash: sha256Hex(OTHER_PREIMAGE) }));
    const res = await readBackSwap(SWAP);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/payment hash/i);
    expectNoSecretEcho(res);
  });

  it.each([
    ["missing", undefined],
    ["short", "0xabcd"],
    ["non-hex", `0x${"zz".repeat(32)}`],
  ])("rejects a %s provider hash_lock", async (_name, hashLock) => {
    sdkWith(stored({}, { hash_lock: hashLock }));
    expect((await readBackSwap(SWAP)).ok).toBe(false);
  });

  it("rejects a non-hex or wrong-length preimage / secret key", async () => {
    for (const over of [{ preimage: "12".repeat(16) }, { secretKey: "34".repeat(16) }, { secretKey: "zz".repeat(32) }]) {
      sdkWith(stored(over));
      expect((await readBackSwap(SWAP)).ok).toBe(false);
    }
  });

  it.each([
    ["zero", "00".repeat(32)],
    ["curve order or above", "ff".repeat(32)],
  ])("rejects a %s secret key that is not a valid secp256k1 scalar", async (_name, secretKey) => {
    sdkWith(stored({ secretKey }));
    const res = await readBackSwap(SWAP);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signing identity/i);
    expectNoSecretEcho(res);
  });

  it("rejects a valid secret key whose address is not the swap claim address (SDK would silently use another key)", async () => {
    sdkWith(stored({ secretKey: OTHER_SECRET }));
    const res = await readBackSwap(SWAP);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/claim address/i);
    expectNoSecretEcho(res);
  });

  it("rejects a swap with no client_evm_address (claim signer unprovable)", async () => {
    sdkWith(stored({}, { client_evm_address: undefined }));
    expect((await readBackSwap(SWAP)).ok).toBe(false);
  });

  it("matches the claim address case-insensitively", async () => {
    sdkWith(stored({}, { client_evm_address: secretAddress(SECRET).toLowerCase() }));
    expect((await readBackSwap(SWAP)).ok).toBe(true);
  });

  it("rejects a stored response whose id differs from the requested swap", async () => {
    sdkWith(stored({}, { id: "other-swap" }));
    expect((await readBackSwap(SWAP)).ok).toBe(false);
  });

  it("legacy fallback: a claim address equal to the SDK wallet identity is accepted only on explicit readback", async () => {
    const wallet = `0x${"56".repeat(20)}`;
    const legacy = stored({}, { client_evm_address: wallet });
    sdkWith(legacy, undefined, wallet);
    expect((await readBackSwap(SWAP)).ok).toBe(true);
    expect((await readBackSwap(SWAP, { allowLegacyWalletIdentity: false })).ok).toBe(false);
    // Unrelated wallet, or a wallet lookup that throws, never validates it.
    sdkWith(legacy, undefined, `0x${"78".repeat(20)}`);
    expect((await readBackSwap(SWAP)).ok).toBe(false);
    sdkWith(legacy, undefined, () => {
      throw new Error("no signer");
    });
    expect((await readBackSwap(SWAP)).ok).toBe(false);
  });
});

describe("createExactReceiveSwap validates stored recovery material before success", () => {
  const terms = { targetAddress: ADDR, tokenAddress: TOKEN, evmChainId: 137, targetAmountAtomic: "5000000" };
  const created = (row: ReturnType<typeof stored>, hashLock: string = row.response.hash_lock) => ({ ...row.response, hash_lock: hashLock });

  it("succeeds when the SDK-persisted swap is consistent with the provider response", async () => {
    const row = stored();
    sdkWith(row, created(row));
    await expect(createExactReceiveSwap(terms)).resolves.toMatchObject({ satoraSwapId: SWAP, paymentHash: row.response.hash_lock });
  });

  it("fails when nothing was persisted (invoice must not reach a payment screen)", async () => {
    sdkWith(null, created(stored()));
    await expect(createExactReceiveSwap(terms)).rejects.toThrow(/recovery material failed validation/i);
  });

  it("fails when the stored preimage does not match, without echoing secrets", async () => {
    const row = stored({ preimage: OTHER_PREIMAGE });
    sdkWith(row, created(row));
    const error = await createExactReceiveSwap(terms).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/recovery material failed validation/i);
    expectNoSecretEcho((error as Error).message);
  });

  it("fails when the stored claim key does not own the claim address", async () => {
    const row = stored({ secretKey: OTHER_SECRET });
    sdkWith(row, created(row));
    await expect(createExactReceiveSwap(terms)).rejects.toThrow(/claim address/i);
  });

  it("a fresh swap never accepts the legacy wallet identity", async () => {
    const wallet = `0x${"56".repeat(20)}`;
    const row = stored({}, { client_evm_address: wallet });
    sdkWith(row, created(row), wallet);
    await expect(createExactReceiveSwap(terms)).rejects.toThrow(/claim address/i);
  });

  it("fails when the persisted swap differs from the hash_lock the create call returned", async () => {
    const row = stored();
    sdkWith(row, created(row, `0x${sha256Hex(OTHER_PREIMAGE)}`));
    await expect(createExactReceiveSwap(terms)).rejects.toThrow(/payment hash differs/i);
  });

  it("fails when the stored invoice does not carry the swap hash / amount", async () => {
    const row = stored({}, { source_amount: "6328" });
    sdkWith(row, created(row));
    await expect(createExactReceiveSwap(terms)).rejects.toThrow(/invoice/i);
  });
});

// ---------------------------------------------------------------- saveHandoffRecord

const record = (over: Partial<Parameters<typeof saveHandoffRecord>[0]> = {}) => ({
  transferId: TRANSFER,
  ownerUserId: OWNER,
  invoice: INVOICE,
  invokedAt: new Date().toISOString(),
  outcomeReported: false,
  reportedOutcome: null,
  sourceTxHash: null,
  ...over,
});

describe("saveHandoffRecord reports durable readback success", () => {
  it("true only when the exact record reads back", () => {
    expect(saveHandoffRecord(record())).toBe(true);
    expect(loadHandoffRecord(TRANSFER, OWNER)?.invoice).toBe(INVOICE);
  });

  it("false when the write throws (quota/private mode) and leaves no record", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(saveHandoffRecord(record())).toBe(false);
    vi.restoreAllMocks();
    expect(loadHandoffRecord(TRANSFER, OWNER)).toBeNull();
  });

  it("false when the write is silently dropped", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
    expect(saveHandoffRecord(record())).toBe(false);
  });

  it("false when storage is unavailable", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(saveHandoffRecord(record())).toBe(false);
  });

  it("restores the previous record when the readback fails (prior reported outcome keeps its meaning)", () => {
    const reported = record({ outcomeReported: true, reportedOutcome: "unknown" });
    expect(saveHandoffRecord(reported)).toBe(true);
    const realSet = Storage.prototype.setItem;
    let first = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      // The new write lands corrupted; the restore write is honoured.
      realSet.call(this, k, first ? `${v}x` : v);
      first = false;
    });
    expect(saveHandoffRecord(record())).toBe(false);
    vi.restoreAllMocks();
    expect(loadHandoffRecord(TRANSFER, OWNER)).toMatchObject({ outcomeReported: true, reportedOutcome: "unknown" });
  });
});

// ---------------------------------------------------------------- useHandoff.invoke

async function arrangeInvoke(providerResult: unknown = { hash: "ab".repeat(32), swapId: "host-swap-1" }) {
  const calls: string[] = [];
  const provider: LightningCapableProvider = {
    payLightningInvoice: (async (req: { invoice: string }) => {
      calls.push(req.invoice);
      return providerResult;
    }) as LightningCapableProvider["payLightningInvoice"],
  };
  (globalThis as { __thencePayProvider?: unknown }).__thencePayProvider = provider;
  const vault = createMemoryVault();
  const binding: RecoveryBinding = {
    version: 1,
    transferId: TRANSFER,
    satoraSwapId: SWAP,
    paymentHash: `0x${HASH}`,
    sourceSats: "6327",
    targetAtomic: "5000000",
    destination: ADDR,
    routeId: "usdc-polygon",
    quoteRevision: 1,
    ownerUserId: OWNER,
    attemptToken: "attempt-token",
    storedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  };
  expect((await vault.saveAndVerify(binding)).status).toBe("ok");
  (globalThis as { __thenceVault?: unknown }).__thenceVault = vault;
  mocks.fetchTransfer.mockResolvedValue({ ok: true, data: { transfer: { status: "AWAITING_NIM_APPROVAL", statusLabel: "Awaiting approval" } } });
  mocks.fetchAttempt.mockResolvedValue({
    ok: true,
    data: { attempt: { id: "a-1" }, swap: { satoraSwapId: SWAP, invoiceExpiresAt: new Date(Date.now() + 600_000).toISOString() } },
  });
  return { calls };
}

const invokeInput = {
  transferId: TRANSFER,
  authorizedInvoice: INVOICE,
  sourceSats: "6327",
  ownerUserId: OWNER,
  sessionValid: true,
  previewMode: false,
};

async function runInvoke() {
  const hook = renderHook(() => useHandoff());
  await act(async () => {
    await hook.result.current.invoke(invokeInput);
  });
  return hook;
}

describe("useHandoff.invoke refuses the native call without a durable replay record", () => {
  beforeEach(() => {
    mocks.fetchTransfer.mockReset();
    mocks.fetchAttempt.mockReset();
    mocks.report.mockReset();
    mocks.report.mockResolvedValue({ ok: true, data: { handoff: { transferId: TRANSFER, status: "LIGHTNING_HANDOFF", deduplicated: false } } });
  });

  it("control: durable storage → exactly one native call and a persisted, reported record", async () => {
    const { calls } = await arrangeInvoke();
    const hook = await runInvoke();
    expect(calls).toEqual([INVOICE]);
    expect(hook.result.current.state.phase).toBe("checking");
    expect(loadHandoffRecord(TRANSFER, OWNER)).toMatchObject({ outcomeReported: true, reportedOutcome: "initiated" });
  });

  it("setItem throws → no native call, no report, attention state", async () => {
    const { calls } = await arrangeInvoke();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const hook = await runInvoke();
    expect(calls).toEqual([]);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe("attention");
  });

  it("write silently dropped → no native call", async () => {
    const { calls } = await arrangeInvoke();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
    const hook = await runInvoke();
    expect(calls).toEqual([]);
    expect(hook.result.current.state.phase).toBe("attention");
  });

  it("storage unavailable → no native call", async () => {
    const { calls } = await arrangeInvoke();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const hook = await runInvoke();
    expect(calls).toEqual([]);
    expect(hook.result.current.state.phase).toBe("attention");
  });

  it("a refused invoke leaves no stale record, so a later invoke with working storage pays exactly once", async () => {
    const { calls } = await arrangeInvoke();
    const broken = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await runInvoke();
    expect(calls).toEqual([]);
    broken.mockRestore();
    expect(loadHandoffRecord(TRANSFER, OWNER)).toBeNull();
    await runInvoke();
    expect(calls).toEqual([INVOICE]);
  });

  it("resume semantics preserved: a lost report after a successful native call never allows a second native call", async () => {
    const { calls } = await arrangeInvoke();
    mocks.report.mockResolvedValue({ ok: false, kind: "network", code: null });
    await runInvoke();
    expect(calls).toEqual([INVOICE]);
    expect(loadHandoffRecord(TRANSFER, OWNER)?.outcomeReported).toBe(false);
    // "Reload": same storage, server still AWAITING_NIM_APPROVAL.
    mocks.report.mockResolvedValue({ ok: true, data: { handoff: { transferId: TRANSFER, status: "OUTCOME_UNKNOWN", deduplicated: false } } });
    const hook = await runInvoke();
    expect(calls).toEqual([INVOICE]);
    expect(hook.result.current.state.phase).toBe("checking");
  });
});
