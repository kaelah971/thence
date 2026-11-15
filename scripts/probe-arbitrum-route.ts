/**
 * Arbitrum pilot readiness — READ-ONLY mainnet canary for `usdc-arbitrum`.
 *
 * Creates nothing: no transfer, no swap, no invoice, no signature, no funds
 * move. It only calls the provider's read endpoints (tokens, pairs, quote) and
 * read-only JSON-RPC methods, and it never writes to any database.
 *
 * What it checks, all against live mainnet:
 *  provider  Satora lists Circle native USDC (0xaf88…5831) on chain 42161 with
 *            6 decimals, the Lightning→42161 pair exists, and exact-output
 *            quotes resolve through the production resolver with the trusted
 *            identity (USDC.e is refused).
 *  chain     The RPC really serves chain 42161; native USDC / USDC.e contract
 *            identity on-chain; the pinned HTLC has code; the `finalized` tag
 *            works and how far it trails; the measured block rate against the
 *            40 000-block scan bound; and an exact-production P4 no-activity
 *            scan (`verifyNoHtlcActivity`) over a realistic finalized window
 *            with a random hash lock, which must return NO_ACTIVITY; and the
 *            claim lifecycle gate (`verifyHtlcLifecycle`) for a random key,
 *            which must decide (NONE) despite the moving head.
 *
 * Usage:
 *   npx tsx scripts/probe-arbitrum-route.ts [--rpc https://…] [--invoice-minutes 90]
 * The RPC defaults to THENCE_EVM_RPCS_JSON["42161"]. Its URL is never printed
 * (host only), so a keyed endpoint can be used safely.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createPublicClient, http, keccak256, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

const NATIVE_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BRIDGED_USDC_E = "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8";
const ERC20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function main(): Promise<void> {
  const configured = (() => {
    try {
      return (JSON.parse(process.env["THENCE_EVM_RPCS_JSON"] || "{}") as Record<string, string>)["42161"];
    } catch {
      return undefined;
    }
  })();
  const rpc = arg("rpc") ?? configured;
  if (!rpc || !rpc.startsWith("https://")) throw new Error("Pass --rpc https://… or set THENCE_EVM_RPCS_JSON[\"42161\"].");
  const invoiceMinutes = Number(arg("invoice-minutes") ?? "90");
  // Process-local only: the production readers below take the RPC from env.
  process.env["THENCE_EVM_RPCS_JSON"] = JSON.stringify({ "42161": rpc });
  process.env["THENCE_ROUTE_TOKENS_JSON"] = JSON.stringify({ "usdc-arbitrum": NATIVE_USDC });

  const { getExactQuote, getProviderPairs, getProviderTokens, resolveRouteWith, TRUSTED_ROUTE_TOKEN_IDENTITIES } = await import("@/lib/satora");
  const { verifyHtlcLifecycle, verifyNoHtlcActivity, TRUSTED_HTLC_CONTRACTS, MAX_HTLC_SCAN_BLOCKS } = await import("@/lib/settlement");
  const { SCAN_LEAD_MS, SCAN_TAIL_MS } = await import("@/lib/expiry-resolution");

  console.log(`== provider (Satora, read-only)  observedAt=${new Date().toISOString()}`);
  const tokens = await getProviderTokens();
  const pairs = await getProviderPairs();
  const arbUsdc = tokens.filter((t) => t.chain === "42161" && /usdc/i.test(t.symbol));
  for (const t of arbUsdc) console.log(`  listed 42161 ${t.symbol} ${t.address} decimals=${t.decimals}`);
  const trusted = TRUSTED_ROUTE_TOKEN_IDENTITIES["usdc-arbitrum"]!;
  const native = arbUsdc.filter((t) => t.address.toLowerCase() === NATIVE_USDC);
  check(trusted.address === NATIVE_USDC && trusted.chainId === "42161" && trusted.decimals === 6, "code trust anchor = Circle native USDC on 42161, 6 decimals");
  check(native.length === 1 && native[0]!.symbol === "USDC" && native[0]!.decimals === 6, "provider lists native USDC exactly once as USDC/6");
  const pair = pairs.find((p) => p.source === "Lightning" && p.target === "42161");
  check(pair !== undefined, "Lightning→42161 pair offered", pair ? `min_sats=${pair.min_sats} max_sats=${pair.max_sats}` : "missing");
  const options = { approvedTokenAddress: NATIVE_USDC, canonicalTokenAddress: NATIVE_USDC, canonicalChainId: "42161" as const, requireApprovedToken: true, expectedTokenDecimals: 6 };
  const resolved = resolveRouteWith(tokens, pairs, "USDC", "Arbitrum", options);
  check(resolved.tokenAddress.toLowerCase() === NATIVE_USDC && resolved.chainId === "42161", "production resolver binds native USDC");
  let refusedUsdcE = false;
  try {
    resolveRouteWith(tokens, pairs, "USDC", "Arbitrum", { ...options, approvedTokenAddress: BRIDGED_USDC_E });
  } catch {
    refusedUsdcE = true;
  }
  check(refusedUsdcE, "resolver refuses USDC.e as the approved token");
  for (const atomic of ["300000", "1000000", "5000000", "25000000"]) {
    try {
      const q = await getExactQuote(resolved, atomic);
      const fees = q.networkFeeSats + q.gaslessNetworkFeeSats + q.protocolFeeSats;
      check(q.netTargetAtomic === atomic, `exact-output quote $${Number(atomic) / 1e6}`, `sourceSats=${q.netSourceSats} feesSats=${fees} min=${q.minSats} max=${q.maxSats}`);
    } catch (error) {
      check(false, `exact-output quote $${Number(atomic) / 1e6}`, error instanceof Error ? error.message : "unknown error");
    }
  }

  console.log(`== chain 42161 via ${new URL(rpc).host} (read-only)`);
  const client = createPublicClient({ chain: arbitrum, transport: http(rpc, { timeout: 15_000 }) });
  check((await client.getChainId()) === 42161, "eth_chainId = 42161");
  const nativeMeta = await Promise.all([
    client.readContract({ address: NATIVE_USDC, abi: ERC20, functionName: "name" }),
    client.readContract({ address: NATIVE_USDC, abi: ERC20, functionName: "symbol" }),
    client.readContract({ address: NATIVE_USDC, abi: ERC20, functionName: "decimals" }),
  ]);
  check(nativeMeta[1] === "USDC" && nativeMeta[2] === 6, "native USDC contract on-chain", `name=${nativeMeta[0]} symbol=${nativeMeta[1]} decimals=${nativeMeta[2]}`);
  // The bridged contract still reports the symbol "USDC" on-chain, so the
  // symbol can never separate the two: only the exact address does.
  const bridgedSymbol = await client.readContract({ address: BRIDGED_USDC_E, abi: ERC20, functionName: "symbol" });
  const providerListsBridged = arbUsdc.some((t) => t.address.toLowerCase() === BRIDGED_USDC_E);
  check(!providerListsBridged, "provider does not list bridged USDC.e (0xff97…5cc8) on 42161", `USDC.e on-chain symbol=${bridgedSymbol} — address-only separation`);
  for (const htlc of TRUSTED_HTLC_CONTRACTS[42161] ?? []) {
    const code = await client.getCode({ address: htlc as `0x${string}` });
    check(code !== undefined && code.length > 2, `pinned HTLC ${htlc} has code`, code ? `bytes=${(code.length - 2) / 2} codehash=${keccak256(code)}` : "no code");
  }

  const latest = await client.getBlock({ blockTag: "latest" });
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const lagBlocks = latest.number - finalized.number;
  const lagSec = Number(latest.timestamp - finalized.timestamp);
  check(finalized.number > 0n && finalized.number <= latest.number, "finalized tag served", `finalized=${finalized.number} lag=${lagBlocks} blocks / ${Math.round(lagSec / 60)} min`);
  const back = await client.getBlock({ blockNumber: latest.number - MAX_HTLC_SCAN_BLOCKS });
  const spanSec = Number(latest.timestamp - back.timestamp);
  const blocksPerSec = Number(MAX_HTLC_SCAN_BLOCKS) / spanSec;
  const windowMin = (SCAN_LEAD_MS + SCAN_TAIL_MS) / 60_000 + invoiceMinutes;
  const windowBlocks = Math.ceil(windowMin * 60 * blocksPerSec);
  const maxInvoiceMin = Math.floor(spanSec / 60 - (SCAN_LEAD_MS + SCAN_TAIL_MS) / 60_000);
  console.log(`  block rate ${blocksPerSec.toFixed(2)}/s: ${MAX_HTLC_SCAN_BLOCKS} blocks ≈ ${Math.round(spanSec / 60)} min; P4 window for a ${invoiceMinutes}-min invoice ≈ ${windowMin} min ≈ ${windowBlocks} blocks; largest invoice lifetime that fits ≈ ${maxInvoiceMin} min`);
  check(windowBlocks <= Number(MAX_HTLC_SCAN_BLOCKS), `P4 scan window for a ${invoiceMinutes}-min invoice fits the ${MAX_HTLC_SCAN_BLOCKS}-block bound`);

  // Exact production P4 scan over a finalized window of the same length,
  // using a random hash lock nobody has ever used: must be NO_ACTIVITY.
  const end = new Date(Number(finalized.timestamp) * 1000 - 5 * 60_000);
  const start = new Date(end.getTime() - Math.min(windowMin, maxInvoiceMin + 60) * 60_000);
  const startedAt = Date.now();
  const scan = await verifyNoHtlcActivity({
    chainId: 42161,
    htlcAddress: TRUSTED_HTLC_CONTRACTS[42161]![0]!,
    hashLock: `0x${randomBytes(32).toString("hex")}`,
    windowStart: start,
    windowEnd: end,
  });
  check(scan.verdict === "NO_ACTIVITY", "production P4 no-activity scan (random hash, finalized window)", `verdict=${scan.verdict} blocks=${scan.fromBlock}..${scan.toBlock} ${Math.round((Date.now() - startedAt) / 1000)}s${scan.verdict === "NO_ACTIVITY" ? "" : ` reason=${scan.reason}`}`);

  // Exact production claim gate (verifyHtlcLifecycle) for a random, never-used
  // SwapKey: it must DECIDE (REJECTED, state NONE) on a chain whose head moves
  // ~4 blocks/s, rather than refusing with an unobservable stable-head rule.
  const lifecycle = await verifyHtlcLifecycle({
    chainId: 42161,
    htlcAddress: TRUSTED_HTLC_CONTRACTS[42161]![0]!,
    hashLock: `0x${randomBytes(32).toString("hex")}`,
    expectedLocktimeSec: Math.floor(Date.now() / 1000) + 3600,
    expectedTokenAddress: NATIVE_USDC,
    expectedAmountAtomic: "300000",
    expectedRefundAddress: "0x0000000000000000000000000000000000000001",
    expectedClaimAddress: "0x0000000000000000000000000000000000000002",
    fundingVerdict: "VERIFIED",
  });
  check(lifecycle.verdict === "REJECTED" && lifecycle.latestState === "NONE", "production claim lifecycle gate decides at a pinned head (random key → NONE)", `verdict=${lifecycle.verdict} reason=${lifecycle.reason}`);

  console.log(failures === 0 ? "RESULT: all read-only checks passed (provider availability only — not proof of settlement)" : `RESULT: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
