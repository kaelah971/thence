/**
 * GET /api/proofs/:id — anonymous read-only global proof detail (A3c.1).
 * Publication is server-gated and disabled by default.
 */
import { NextResponse } from "next/server";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  getPublicProof,
  isPublicProofPublicationEnabled,
  publicProofConfig,
} from "@/lib/global-proofs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function disabledResponse(): NextResponse {
  return NextResponse.json(
    { error: "PUBLIC_PROOFS_DISABLED", message: "Public proof publication is not enabled." },
    { status: 404, headers: NO_STORE },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isPublicProofPublicationEnabled()) return disabledResponse();
  try {
    const env = getEnv();
    const limited = await checkRateLimits([
      { key: `public-proofs-read:${clientKeyFromHeaders(request.headers)}`, limit: env.THENCE_PUBLIC_PROOFS_READ_RATE_PER_MINUTE },
      { key: globalRateKey("public-proofs-read"), limit: env.THENCE_ANON_GLOBAL_PER_MINUTE },
    ]);
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds) } },
      );
    }
    const { id } = await context.params;
    const proof = await getPublicProof(
      id,
      publicProofConfig({ routeTokens: env.THENCE_ROUTE_TOKENS_JSON, finalityPolicies: env.THENCE_SETTLEMENT_FINALITY_JSON }),
    );
    if (!proof) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Proof not found." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ proof }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { error: "PROOF_DETAIL_FAILED", message: "Could not read the public proof." },
      { status: 500, headers: NO_STORE },
    );
  }
}
