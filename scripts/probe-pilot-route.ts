/**
 * F8.2 — read-only pilot route probe (activation pre-flight, §4).
 *
 * Prints the LIVE provider facts the funded test depends on — canonical
 * USDC contract on Polygon (chain 137), pair limits, and the exact-output
 * source sats for the 300000-atomic ($0.30) pilot amount — without creating
 * anything: no transfer, no swap, no invoice, no funds move.
 *
 * Usage: npx tsx scripts/probe-pilot-route.ts
 * Compare the printed token address against THENCE_ROUTE_TOKENS_JSON
 * before activation; a mismatch blocks quoting fail-closed.
 */
import "dotenv/config";
import { getExactQuote, getProviderPairs, getProviderTokens, resolveRoute } from "@/lib/satora";

async function main(): Promise<void> {
  const tokens = await getProviderTokens();
  const pairs = await getProviderPairs();
  const usdc137 = tokens.filter((t) => t.symbol === "USDC" && t.chain === "137");
  console.log(`provider tokens: ${tokens.length} total, USDC-on-137 listings: ${usdc137.length}`);
  for (const t of usdc137) {
    console.log(`  USDC 137 address=${t.address} decimals=${t.decimals}`);
  }
  const pair = pairs.find((p) => p.source === "Lightning" && p.target === "137");
  console.log(`lightning->137 pair: ${pair ? `min_sats=${pair.min_sats} max_sats=${pair.max_sats}` : "MISSING (route not offered)"}`);

  const resolved = await resolveRoute("USDC", "Polygon");
  console.log(`resolved usdc-polygon: chain=${resolved.chainId} token=${resolved.tokenAddress} minSats=${resolved.minSats} maxSats=${resolved.maxSats}`);
  const quote = await getExactQuote(resolved, "300000");
  console.log(`exact-output $0.30 quote: netTarget=${quote.netTargetAtomic} sourceSats=${quote.netSourceSats} fees=${quote.networkFeeSats + quote.gaslessNetworkFeeSats + quote.protocolFeeSats}sats`);
}

main().catch((error: unknown) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
