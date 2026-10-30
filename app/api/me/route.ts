/**
 * GET /api/me — return the authenticated user's identity (B1).
 * Identity comes ONLY from the verified session. 401 otherwise.
 */
import { NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request.headers);
    const rows = await getDb()
      .select({
        id: users.id,
        nimiqAddress: users.nimiqAddress,
        createdAt: users.createdAt,
        displayName: users.displayName,
        onboardingCompletedAt: users.onboardingCompletedAt,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
    }
    return NextResponse.json(
      {
        user: { id: user.id, nimiqAddress: user.nimiqAddress, createdAt: user.createdAt.toISOString() },
        // F2: additive profile block (name + onboarding completion).
        profile: {
          displayName: user.displayName,
          onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "ME_FAILED", message: "Could not load identity." }, { status: 500 });
  }
}
