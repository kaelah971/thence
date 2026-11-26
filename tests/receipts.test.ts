import { describe, expect, it } from "vitest";
import { amountOf, toCsv } from "@/lib/receipts";

const row = {
  id: "t1",
  createdAt: "2026-11-26T10:00:00.000Z",
  status: "DELIVERED",
  asset: "USDC",
  amountAtomic: "2500000",
  amount: "2.50",
  network: "Polygon",
  recipient: "0xabc",
  nimiqTxHash: "ab".repeat(32),
  payoutTxHash: `0x${"cd".repeat(32)}`,
};

describe("receipt exports", () => {
  it("formats atomic amounts with two decimals minimum", () => {
    expect(amountOf("2500000")).toBe("2.50");
    expect(amountOf("100000")).toBe("0.10");
    expect(amountOf("1000001")).toBe("1.000001");
  });

  it("writes one header and one line per payment", () => {
    const csv = toCsv([row, { ...row, id: "t2" }]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("date,status,amount,asset,network,recipient,nimiq_tx,payout_tx");
    expect(lines[1]).toContain("2.50,USDC,Polygon");
  });

  it("quotes commas and neutralises spreadsheet formulas", () => {
    const csv = toCsv([{ ...row, recipient: "=cmd|calc, A1" }]);
    expect(csv).toContain(`"'=cmd|calc, A1"`);
  });

  it("leaves missing hashes as empty cells, never the word null", () => {
    const csv = toCsv([{ ...row, nimiqTxHash: null, payoutTxHash: null }]);
    expect(csv).not.toContain("null");
    expect(csv.trim().split("\n")[1]).toMatch(/,,$/);
  });
});
