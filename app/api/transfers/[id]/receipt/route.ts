/**
 * GET /api/transfers/:id/receipt — immutable delivery receipt (B4.4).
 * Owner-only. Before DELIVERED, returns a receipt-not-ready response.
 * No PDF or public sharing in this slice; the frontend renders the receipt.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import { getDb } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { swapAttachments, transferProofs, transfers } from "@/db/schema";
import type { TransferStatus } from "@/domain/transfers";
import { explorerTxUrl } from "@/lib/settlement";

function parseLogIndexes(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const env = getEnv();
    const limited = await checkRateLimit(
      `transfers-read:${rateLimitKeyFor(session.userId, request.headers)}`,
      env.THENCE_TRANSFERS_READ_RATE_PER_MINUTE,
    );
    if (limited.allowed === false) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const db = getDb();
    const rows = await db
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, id), eq(transfers.ownerUserId, session.userId)))
      .limit(1);
    const transfer = rows[0];
    if (!transfer) throw new AuthError(404, "NOT_FOUND", "Transfer not found.");
    const status = transfer.status as TransferStatus;
    if (status !== "DELIVERED") {
      return NextResponse.json(
        { error: "RECEIPT_NOT_READY", message: "Receipt is available after verified delivery.", status },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const proofs = await db.select().from(transferProofs).where(eq(transferProofs.transferId, transfer.id)).limit(1);
    const proof = proofs[0];
    const bound = await db.select().from(swapAttachments).where(eq(swapAttachments.transferId, transfer.id)).limit(1);
    if (
      !proof ||
      proof.chainId === null ||
      !proof.evmTxHash ||
      !proof.tokenContract ||
      !proof.recipient ||
      !proof.verifiedAmountAtomic ||
      proof.blockNumber === null ||
      !proof.blockHash ||
      !proof.finalityLevel ||
      !proof.verifiedAt
    ) {
      return NextResponse.json(
        { error: "RECEIPT_NOT_READY", message: "Structured settlement evidence is missing.", status },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        receipt: {
          transferId: transfer.id,
          recipientName: transfer.recipientName ?? null,
          asset: transfer.targetAsset,
          network: transfer.targetNetwork,
          destination: transfer.destination,
          requestedAmountAtomic: transfer.targetAmountAtomic,
          verifiedAmountAtomic: proof.verifiedAmountAtomic,
          provider: transfer.quoteProvider ?? "satora",
          satoraSwapId: proof.satoraSwapId ?? bound[0]?.satoraSwapId ?? null,
          settlementTxHash: proof.evmTxHash,
          chainId: proof.chainId,
          blockNumber: String(proof.blockNumber),
          blockHash: proof.blockHash,
          logIndexes: parseLogIndexes(proof.logIndexes),
          finalityLevel: proof.finalityLevel,
          verifiedAt: proof.verifiedAt.toISOString(),
          explorerTxUrl: explorerTxUrl(proof.chainId, proof.evmTxHash),
          // The quoted source is an estimate only: B4.4 never proves the
          // actual debited amount, only the verified destination output.
          quotedSourceSatsEstimate: transfer.quotedSourceSats ?? null,
          actualFundingProven: false,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "RECEIPT_FAILED", message: "Request failed." }, { status: 500 });
  }
}
