import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { readJsonBody } from "@/lib/recipients";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { DeskError } from "@/lib/desk/policy";
import { authorizeDesk, checkDeskOrder, listDeskOrders, quoteDesk, reportDeskDeposit, reportDeskRefund, requestDeskRefund } from "@/lib/desk/service";

export const runtime = "nodejs";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), recipient: z.string().max(42), amount: z.string().max(40), requestKey: z.string().max(80) }).strict(),
  z.object({ action: z.literal("authorize"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("check"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("request-refund"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("report"), id: z.string().uuid(), hash: z.string().max(66) }).strict(),
  z.object({ action: z.literal("refund"), id: z.string().uuid(), hash: z.string().max(66) }).strict(),
]);
function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function failed(error: unknown) {
  if (error instanceof AuthError || error instanceof DeskError) return response({ error: error.code, message: error.message }, error.status);
  return response({ error: "DESK_UNAVAILABLE", message: "Payment status is unavailable. If you already approved NIM, do not pay again." }, 503);
}
export async function GET(request: Request) {
  try {
    const session = await requireSession(request.headers);
    return response(await listDeskOrders(session.userId, session.nimiqAddress));
  } catch (error) { return failed(error); }
}
/** Only authenticated, same-origin POST can authorize or advance a treasury payout. */
export async function POST(request: Request) {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const limited = await checkRateLimit(`desk:${rateLimitKeyFor(session.userId, request.headers)}`, 20);
    if (!limited.allowed) return response({ error: "RATE_LIMITED", message: "Wait a minute, then check this payment again." }, 429);
    const parsed = command.safeParse(await readJsonBody(request));
    if (!parsed.success) return response({ error: "INVALID_INPUT", message: "Invalid payment request." }, 400);
    const input = parsed.data, owner = session.nimiqAddress, user = session.userId;
    if (input.action === "quote") return response({ order: await quoteDesk(user, owner, input.recipient, input.amount, input.requestKey) });
    if (input.action === "authorize") return response(await authorizeDesk(user, owner, input.id));
    if (input.action === "report") return response({ order: await reportDeskDeposit(user, owner, input.id, input.hash) });
    if (input.action === "refund") return response({ order: await reportDeskRefund(user, owner, input.id, input.hash) });
    if (input.action === "request-refund") return response({ order: await requestDeskRefund(user, owner, input.id) });
    return response({ order: await checkDeskOrder(user, owner, input.id) });
  } catch (error) { return failed(error); }
}
