/**
 * Deterministic Satora reference data and quotes for the INTEGRATION suite.
 *
 * Why: integration tests create transfers, and transfer creation takes a live
 * exact-output quote. With the real api.satora.io behind it, a provider outage
 * (PROVIDER_TIMEOUT / PROVIDER_UNAVAILABLE) failed unrelated release tests and
 * blocked releases on Satora's uptime.
 *
 * What it replaces: ONLY the network calls of the singleton SDK client used by
 * src/lib/satora.ts (getTokens, getSwapPairs, getQuote), in test workers.
 * Everything Thence does with the responses (token identity and route
 * resolution, exact-output checks, fee/amount parsing, min/max, staleness,
 * timeouts via per-test spies) runs unchanged. Production code is untouched:
 * nothing here is imported outside tests.
 *
 * Data: the token catalogue and swap pairs are the captured real Satora
 * responses in e2e/fixtures. Quotes use the composition of the captured real
 * 0.30 USDC quote (`satora-quote-300000.json`: exchange rate, network fee,
 * 0.5 % protocol fee, floor rounding), so `quoteFor(300000)` reproduces that
 * captured response exactly (pinned by tests/satora-fixture.test.ts).
 *
 * Opt out (live provider): THENCE_TEST_LIVE_SATORA=1. The live provider is
 * checked separately and explicitly by tests/satora-live-canary.test.ts and
 * scripts/probe-arbitrum-route.ts; an outage there is reported as an outage,
 * never as a passing integration run.
 *
 * Per-test overrides still win: setSatoraFetchersForTests(...) is consulted
 * before the client, and vi.spyOn(client, "getQuote") wraps (and on restore
 * returns to) this deterministic implementation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(__dirname, "..", "e2e", "fixtures");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

export const CAPTURED_TOKENS = read("satora-tokens.json") as { evm_tokens: Array<{ token_id: string; chain: string; decimals: number; symbol: string }> };
export const CAPTURED_PAIRS = read("satora-swap-pairs.json");
export const CAPTURED_QUOTE_300000 = read("satora-quote-300000.json") as Record<string, unknown>;

const RATE = String(CAPTURED_QUOTE_300000["exchange_rate"]);
const NETWORK_FEE = Number(CAPTURED_QUOTE_300000["network_fee"]);
const GASLESS_FEE = Number(CAPTURED_QUOTE_300000["gasless_network_fee"]);
const FEE_RATE = Number(CAPTURED_QUOTE_300000["protocol_fee_rate"]);
const MIN = Number(CAPTURED_QUOTE_300000["min_amount"]);
const MAX = Number(CAPTURED_QUOTE_300000["max_amount"]);

/** Satora's quote request shape as src/lib/satora.ts sends it. */
export interface QuoteRequest {
  sourceChain: string;
  sourceToken: string;
  targetChain: string | number;
  targetToken: string;
  targetAmount: bigint;
}

/**
 * Exact-output quote in Satora's response shape. Stablecoin targets are priced
 * at 1 unit = 1 USD against the captured BTC/USD exchange rate; the source is
 * rounded like the captured response. Unknown tokens are refused the way the
 * provider refuses them (an error), never silently priced.
 */
export function quoteFor(req: QuoteRequest): Record<string, unknown> {
  const token = CAPTURED_TOKENS.evm_tokens.find(
    (t) => t.chain === String(req.targetChain) && t.token_id.toLowerCase() === String(req.targetToken).toLowerCase(),
  );
  if (!token) throw Object.assign(new Error("Unsupported target token (deterministic Satora fixture)"), { code: 400 });
  if (req.sourceChain !== "Lightning" || req.sourceToken !== "btc") {
    throw Object.assign(new Error("Unsupported source (deterministic Satora fixture)"), { code: 400 });
  }
  const target = req.targetAmount;
  // sats = target / 10^decimals (USD) * 1e8 / rate, rounded like the capture.
  const rateMicro = BigInt(Math.round(Number(RATE) * 1e6));
  const scale = 10n ** BigInt(token.decimals);
  const sats = Number((target * 100_000_000n * 1_000_000n + (rateMicro * scale) / 2n) / (rateMicro * scale));
  const protocolFee = Math.max(1, Math.floor(sats * FEE_RATE));
  return {
    exchange_rate: RATE,
    network_fee: NETWORK_FEE,
    gasless_network_fee: GASLESS_FEE,
    protocol_fee: protocolFee,
    protocol_fee_rate: FEE_RATE,
    min_amount: MIN,
    max_amount: MAX,
    source_amount: String(sats),
    target_amount: target.toString(),
    net_source_amount: String(sats + NETWORK_FEE + GASLESS_FEE + protocolFee),
    net_target_amount: target.toString(),
  };
}

export function isLiveSatoraRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env["THENCE_TEST_LIVE_SATORA"] === "1";
}

/**
 * Point the worker's singleton Satora client at the deterministic provider.
 * Idempotent. Returns false (and changes nothing) when the live provider was
 * explicitly requested.
 */
export async function installDeterministicSatora(): Promise<boolean> {
  if (isLiveSatoraRequested()) return false;
  const { getSatoraClient } = await import("@/lib/satora");
  const client = (await getSatoraClient()) as unknown as Record<string, unknown>;
  if (client["__thenceDeterministic"] === true) return true;
  Object.defineProperty(client, "__thenceDeterministic", { value: true });
  client["getTokens"] = async () => structuredClone(CAPTURED_TOKENS);
  client["getSwapPairs"] = async () => structuredClone(CAPTURED_PAIRS);
  client["getQuote"] = async (req: QuoteRequest) => quoteFor(req);
  return true;
}
