/**
 * A3c.2 — Proof feed client: only fully verified proofs are displayed, amounts
 * are exact, the publication gate maps to a deliberate unavailable state, and
 * preview fixtures can never pass for (or link to) real payments.
 */
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_PROOFS } from "@/ui/fixtures/preview";
import {
  classifyProofFailure,
  compactNimiqAddress,
  displayableProofs,
  explorerHost,
  getProof,
  isDisplayableProof,
  listProofs,
  safeExplorerUrl,
  toProofDisplay,
  type ProofView,
} from "@/ui/lib/proofs-api";

const SENDER = "NQ07 0011 2233 4455 6677 8899 AABB CCDD EEFF";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

type ProofOverrides = Omit<Partial<ProofView>, "source" | "destination"> & { source?: Partial<ProofView["source"]>; destination?: Partial<ProofView["destination"]> };

function proof(overrides: ProofOverrides = {}): ProofView {
  const { source, destination, ...rest } = overrides;
  return {
    proofId: "11111111-1111-4111-8111-111111111111",
    status: "DELIVERED",
    verification: { destination: "VERIFIED", source: "VERIFIED", overall: "VERIFIED" },
    ...rest,
    destination: {
      asset: "USDC",
      network: "Polygon",
      chainId: 137,
      tokenContract: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      recipient: RECIPIENT,
      requestedAmountAtomic: "300000",
      verifiedAmountAtomic: "300000",
      decimals: 6,
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "64000000",
      blockHash: `0x${"cd".repeat(32)}`,
      finalityLevel: "finalized",
      verifiedAt: "2026-11-10T14:32:00.000Z",
      explorerTxUrl: `https://polygonscan.com/tx/0x${"ab".repeat(32)}`,
      ...destination,
    },
    source: {
      asset: "NIM",
      network: "mainnet",
      sender: SENDER,
      amountLuna: "250000",
      feeLuna: "0",
      totalDebitLuna: "250000",
      decimals: 5,
      transactionHash: "12".repeat(32),
      blockNumber: "4200000",
      confirmations: 12,
      verifiedAt: "2026-11-10T14:31:00.000Z",
      explorerTxUrl: `https://nimiq.watch/#${"12".repeat(32)}`,
      evidence: "VERIFIED",
      verification: "VERIFIED",
      note: "Independently verified native NIM HTLC funding.",
      ...source,
    },
  } as ProofView;
}

describe("isDisplayableProof", () => {
  it("accepts a fully verified Polygon or Arbitrum proof", () => {
    expect(isDisplayableProof(proof())).toBe(true);
    expect(isDisplayableProof(proof({ destination: { network: "Arbitrum", chainId: 42161 } }))).toBe(true);
  });

  it.each([
    ["not delivered", proof({ status: "CLAIMING" as never })],
    ["source not verified", proof({ verification: { destination: "VERIFIED", source: "UNKNOWN" as never, overall: "VERIFIED" } })],
    ["overall not verified", proof({ verification: { destination: "VERIFIED", source: "VERIFIED", overall: "PENDING" as never } })],
    ["source evidence missing", proof({ source: { evidence: undefined as never } })],
    ["unsupported chain", proof({ destination: { network: "Ethereum" as never, chainId: 1 as never } })],
    ["chain id mismatch", proof({ destination: { network: "Polygon", chainId: 42161 } })],
    ["zero USDC", proof({ destination: { verifiedAmountAtomic: "0" } })],
    ["zero NIM", proof({ source: { amountLuna: "000" } })],
    ["fractional atomic", proof({ destination: { verifiedAmountAtomic: "1.5" } })],
    ["bad recipient", proof({ destination: { recipient: "0x123" } })],
    ["bad sender", proof({ source: { sender: "NQ00" } })],
    ["missing destination tx", proof({ destination: { transactionHash: "" } })],
    ["missing source tx", proof({ source: { transactionHash: "nope" } })],
    ["bad date", proof({ destination: { verifiedAt: "yesterday" } })],
  ])("rejects %s", (_label, value) => {
    expect(isDisplayableProof(value)).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 1, "x", [], {}]) expect(isDisplayableProof(value)).toBe(false);
  });
});

describe("displayableProofs", () => {
  it("drops unverified and duplicate items and keeps server order", () => {
    const a = proof({ proofId: "a" });
    const b = proof({ proofId: "b" });
    const bad = proof({ proofId: "c", verification: { destination: "VERIFIED", source: "UNKNOWN" as never, overall: "VERIFIED" } });
    expect(displayableProofs([a, bad, b, a]).map((p) => p.proofId)).toEqual(["a", "b"]);
    expect(displayableProofs([a, b], new Set(["a"])).map((p) => p.proofId)).toEqual(["b"]);
    expect(displayableProofs(null)).toEqual([]);
  });
});

describe("toProofDisplay", () => {
  it("formats exact verified amounts with bigint precision", () => {
    const d = toProofDisplay(proof());
    expect(d.nimSent).toBe("2.50");
    expect(d.usdcReceived).toBe("0.30");
    expect(d.network).toBe("Polygon");
    const precise = toProofDisplay(proof({ source: { amountLuna: "123456789", totalDebitLuna: "123456889", feeLuna: "100" }, destination: { verifiedAmountAtomic: "1234567" } }));
    expect(precise.nimSent).toBe("1,234.56789");
    expect(precise.nimFee).toBe("0.001");
    expect(precise.nimTotal).toBe("1,234.56889");
    // Never rounded: all six on-chain USDC decimals survive.
    expect(precise.usdcReceived).toBe("1.234567");
  });

  it("shows a requested amount only when it differs from the verified amount", () => {
    const d = toProofDisplay(proof({ destination: { requestedAmountAtomic: "300000", verifiedAmountAtomic: "300001" } }));
    expect(d.usdcRequested).toBe("0.30");
    expect(d.usdcReceived).toBe("0.300001");
  });

  it("truncates addresses for cards and keeps the exact values for detail", () => {
    const d = toProofDisplay(proof());
    expect(d.senderShort).toBe("NQ07 … EEFF");
    expect(d.recipientShort).toBe("0x2222…2222");
    expect(d.sender).toBe(SENDER);
    expect(d.recipient).toBe(RECIPIENT);
  });

  it("labels finality and explorers", () => {
    expect(toProofDisplay(proof()).finalityLabel).toBe("Finalized");
    expect(toProofDisplay(proof({ destination: { finalityLevel: "confirmations-128" } })).finalityLabel).toBe("128 confirmations");
    const d = toProofDisplay(proof());
    expect(explorerHost(d.destinationExplorerUrl)).toBe("polygonscan.com");
    expect(explorerHost(d.sourceExplorerUrl)).toBe("nimiq.watch");
  });

  it("never renders a non-https explorer link", () => {
    expect(safeExplorerUrl("javascript:alert(1)")).toBeNull();
    expect(safeExplorerUrl("http://polygonscan.com/tx/1")).toBeNull();
    expect(safeExplorerUrl("")).toBeNull();
    expect(toProofDisplay(proof({ destination: { explorerTxUrl: "javascript:alert(1)" } })).destinationExplorerUrl).toBeNull();
  });

  it("compacts Nimiq addresses to first and last group", () => {
    expect(compactNimiqAddress(SENDER)).toBe("NQ07 … EEFF");
    expect(compactNimiqAddress("short")).toBe("short");
  });
});

describe("API contract", () => {
  it("requests the feed with limit and opaque cursor", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ proofs: [], pagination: { limit: 20, nextCursor: null, hasMore: false } }), { status: 200 }));
    await listProofs({ cursor: "abc_-123" }, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/proofs?limit=20&cursor=abc_-123");
    await listProofs({}, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/proofs?limit=20");
  });

  it("requests a single proof with an encoded id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 404 }));
    await getProof("a/b", { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/proofs/a%2Fb");
  });

  it("maps the publication gate to a deliberate unavailable state", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify({ error: "PUBLIC_PROOFS_DISABLED", message: "Public proof publication is not enabled." }), { status: 404 }),
    );
    const result = await listProofs({}, { fetch: fetchMock as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(classifyProofFailure(result)).toEqual({ state: "unavailable" });
  });

  it("separates not-found, rate limits and server errors", () => {
    expect(classifyProofFailure({ ok: false, status: 404, kind: "not-found", code: "NOT_FOUND" })).toEqual({ state: "not-found" });
    const limited = classifyProofFailure({ ok: false, status: 429, kind: "rate-limited", code: "RATE_LIMITED" });
    expect(limited.state).toBe("error");
    if (limited.state === "error") expect(limited.message).toMatch(/wait a moment/i);
    const server = classifyProofFailure({ ok: false, status: 500, kind: "server", code: "PROOF_FEED_FAILED" });
    expect(server.state).toBe("error");
    if (server.state === "error") expect(server.message).not.toMatch(/PROOF_FEED_FAILED|API/);
  });
});

describe("preview fixtures", () => {
  it("are branded preview, carry no explorer links and use non-genuine identifiers", () => {
    expect(PREVIEW_PROOFS.length).toBeGreaterThan(0);
    for (const fixture of PREVIEW_PROOFS) {
      expect(fixture.preview).toBe(true);
      expect(safeExplorerUrl(fixture.destination.explorerTxUrl)).toBeNull();
      expect(safeExplorerUrl(fixture.source.explorerTxUrl)).toBeNull();
      expect(fixture.source.sender).toMatch(/PREV IEW0/);
      expect(fixture.destination.recipient).toMatch(/^0x0{30,}/);
      expect(fixture.destination.transactionHash).toMatch(/^0x0{56,}/);
      expect(fixture.source.note).toMatch(/preview/i);
    }
  });
});

describe("R7 short deliveries in the public feed", () => {
  const short = (destination: Partial<ProofView["destination"]> = {}) =>
    proof({ status: "DELIVERED_SHORT", destination: { requestedAmountAtomic: "1000000", verifiedAmountAtomic: "999556", shortfallAtomic: "444", deliveryOutcome: "SHORT", ...destination } });

  it("shows a self-consistent short delivery with its own label and exact amounts", () => {
    expect(isDisplayableProof(short())).toBe(true);
    const d = toProofDisplay(short());
    expect(d.outcome).toBe("SHORT");
    expect(d.outcomeLabel).toBe("Delivered — less than requested");
    expect(d.usdcRequested).toBe("1.00");
    expect(d.usdcReceived).toBe("0.999556");
    expect(d.usdcShortfall).toBe("0.000444");
  });

  it("drops any short record whose disclosure does not add up", () => {
    expect(isDisplayableProof(short({ shortfallAtomic: "443" }))).toBe(false);
    const without = (key: "shortfallAtomic" | "deliveryOutcome"): ProofView => {
      const p = short();
      const destination = { ...p.destination };
      delete destination[key];
      return { ...p, destination };
    };
    expect(isDisplayableProof(without("shortfallAtomic"))).toBe(false);
    expect(isDisplayableProof(without("deliveryOutcome"))).toBe(false);
    expect(isDisplayableProof(short({ verifiedAmountAtomic: "1000000", shortfallAtomic: "0" }))).toBe(false);
  });

  it("never lets a full-delivery record carry a short marker or a below-request amount", () => {
    expect(isDisplayableProof(proof({ destination: { shortfallAtomic: "444", deliveryOutcome: "SHORT" } }))).toBe(false);
    expect(isDisplayableProof(proof({ destination: { requestedAmountAtomic: "1000000", verifiedAmountAtomic: "999556" } }))).toBe(false);
    const full = toProofDisplay(proof());
    expect(full.outcome).toBe("FULL");
    expect(full.outcomeLabel).toBe("Delivered");
    expect(full.usdcShortfall).toBeNull();
  });
});
