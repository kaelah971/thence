/**
 * GET /api/proofs — anonymous read-only global proof feed (A3c.1).
 *
 * Publication is server-gated and disabled by default. The endpoint never
 * starts, retries, or mutates a payment; it only serializes committed proof
 * rows that passed the publication gate.
 */
import { NextResponse } from "next/server";
import { checkRateLimits, clientKeyFromHeaders, globalRateKey } from "@/lib/rate-limit";
import { getEnv } from "@/lib/env";
import {
  isPublicProofPublicationEnabled,
  listPublicProofs,
  parseProofFeedQuery,
  publicProofConfig,
  PublicProofQueryError,
} from "@/lib/global-proofs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function disabledResponse(): NextResponse {
  return NextResponse.json(
    { error: "PUBLIC_PROOFS_DISABLED", message: "Public proof publication is not enabled." },
    { status: 404, headers: NO_STORE },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
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
    const query = parseProofFeedQuery(request.url);
    const feed = await listPublicProofs(
      query,
      publicProofConfig({ routeTokens: env.THENCE_ROUTE_TOKENS_JSON, finalityPolicies: env.THENCE_SETTLEMENT_FINALITY_JSON }),
    );
    return NextResponse.json(feed, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof PublicProofQueryError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
    }
    return NextResponse.json(
      { error: "PROOF_FEED_FAILED", message: "Could not read the public proof feed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
