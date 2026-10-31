/**
 * GET /api/me/balance — confirmed on-chain NIM balance of the session's
 * verified address (F6). Read-only display data; never payment proof.
 *
 * The address comes ONLY from the verified session. 503 when no trusted
 * Nimiq RPC is configured or the node can't be read — never a zero.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { AuthError, requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NimiqBalanceReadError, NimiqBalanceUnavailableError, readChainBalance } from "@/lib/nimiq-balance";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";

const BALANCE_READS_PER_MINUTE = 30;
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const limit = await checkRateLimit(`balance:${rateLimitKeyFor(session.userId, request.headers)}`, BALANCE_READS_PER_MINUTE);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const rows = await getDb().select({ nimiqAddress: users.nimiqAddress }).from(users).where(eq(users.id, session.userId)).limit(1);
    const address = rows[0]?.nimiqAddress;
    if (!address) return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required." }, { status: 401, headers: NO_STORE });
    const balance = await readChainBalance(address);
    return NextResponse.json({ balance: { ...balance, source: "chain" } }, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    }
    if (err instanceof NimiqBalanceUnavailableError) {
      // Static code only: never an address, URL, or body.
      console.warn("thence balance fallback: rpc_not_configured");
      return NextResponse.json({ error: "BALANCE_NOT_CONFIGURED", message: "Balance lookup is unavailable." }, { status: 503, headers: NO_STORE });
    }
    // Static failure class only (rate_limited | timeout | failed): the exact
    // layer is visible in Vercel logs without exposing any request data.
    const reason = err instanceof NimiqBalanceReadError ? err.reason : "failed";
    console.warn(`thence balance fallback: rpc_${reason}`);
    return NextResponse.json({ error: "BALANCE_READ_FAILED", message: "Couldn't read the Nimiq network." }, { status: 503, headers: NO_STORE });
  }
}
