import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { transferProofs, transfers } from "@/db/schema";

/**
 * Owner receipts: one row per payment, with the two transaction hashes that
 * prove it. Nothing is computed from anything but committed rows.
 */
export interface ReceiptRow {
  id: string;
  createdAt: string;
  status: string;
  asset: string;
  amountAtomic: string;
  amount: string;
  network: string;
  recipient: string;
  nimiqTxHash: string | null;
  payoutTxHash: string | null;
}

export function amountOf(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const fraction = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

export async function listReceipts(userId: string, range: { from?: Date; to?: Date } = {}): Promise<ReceiptRow[]> {
  const conditions = [eq(transfers.ownerUserId, userId)];
  if (range.from) conditions.push(gte(transfers.createdAt, range.from));
  if (range.to) conditions.push(lte(transfers.createdAt, range.to));
  const rows = await getDb()
    .select({
      id: transfers.id,
      createdAt: transfers.createdAt,
      status: transfers.status,
      asset: transfers.targetAsset,
      amountAtomic: transfers.targetAmountAtomic,
      network: transfers.targetNetwork,
      recipient: transfers.destination,
      nimiqTxHash: transferProofs.nimiqTxHash,
      payoutTxHash: transferProofs.evmTxHash,
    })
    .from(transfers)
    .leftJoin(transferProofs, eq(transferProofs.transferId, transfers.id))
    .where(and(...conditions))
    .orderBy(desc(transfers.createdAt))
    .limit(500);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), amount: amountOf(row.amountAtomic) }));
}

const cell = (value: string | null): string => {
  if (value === null) return "";
  // Neutralise spreadsheet formulas: a leading =, +, - or @ is data, not code.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function toCsv(rows: ReceiptRow[]): string {
  const header = ["date", "status", "amount", "asset", "network", "recipient", "nimiq_tx", "payout_tx"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.createdAt, row.status, row.amount, row.asset, row.network, row.recipient,
      row.nimiqTxHash ?? "", row.payoutTxHash ?? "",
    ].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
