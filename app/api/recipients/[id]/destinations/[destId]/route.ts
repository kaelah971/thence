/**
 * PATCH /api/recipients/:id/destinations/:destId — edit a destination (B2.1).
 * DELETE /api/recipients/:id/destinations/:destId — remove it (B2.1).
 * Deleting the default promotes the most recent sibling when one exists.
 */
import { NextResponse } from "next/server";
import { AuthError, assertSafeOrigin, requireSession } from "@/lib/auth";
import { checkRateLimit, rateLimitKeyFor } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  deleteDestination,
  destinationPatchSchema,
  readJsonBody,
  rejectForbiddenKeys,
  updateDestination,
} from "@/lib/recipients";

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "DESTINATION_FAILED", message: "Request failed." }, { status: 500 });
}

async function writeGuard(request: Request, userId: string): Promise<null | NextResponse> {
  const env = getEnv();
  const limited = await checkRateLimit(
    `recipients-write:${rateLimitKeyFor(userId, request.headers)}`,
    env.THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE,
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }
  return null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; destId: string }> },
): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const blocked = await writeGuard(request, session.userId);
    if (blocked) return blocked;
    const { id, destId } = await context.params;
    const body = await readJsonBody(request);
    rejectForbiddenKeys(body);
    if (typeof body !== "object" || body === null) {
      throw new AuthError(400, "BAD_BODY", "Request body must be a JSON object.");
    }
    const parsed = destinationPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AuthError(400, "BAD_BODY", parsed.error.issues[0]?.message ?? "Invalid destination.");
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new AuthError(400, "BAD_BODY", "Nothing to update.");
    }
    const updated = await updateDestination(session.userId, id, destId, parsed.data);
    if (!updated) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Destination not found." }, { status: 404 });
    }
    return NextResponse.json({ destination: updated }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; destId: string }> },
): Promise<NextResponse> {
  try {
    assertSafeOrigin(request);
    const session = await requireSession(request.headers);
    const blocked = await writeGuard(request, session.userId);
    if (blocked) return blocked;
    const { id, destId } = await context.params;
    const result = await deleteDestination(session.userId, id, destId);
    if (!result) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Destination not found." }, { status: 404 });
    }
    return NextResponse.json({ deleted: true }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
