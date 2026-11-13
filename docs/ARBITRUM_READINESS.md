# Arbitrum native USDC — readiness (2026-11-13)

Route `usdc-arbitrum` (NIM → Lightning → Satora → native USDC on Arbitrum One).
**Status: implemented, NOT enabled in production.** Production
`/api/health` reports `enabledRoutes: ["usdc-polygon"]`. No real-money Arbitrum
payment, claim or refund has been made.

## Read-only evidence (2026-11-13, no swaps created)

| Check | Result |
|---|---|
| Provider token catalogue, chain 42161 | `USDC` = `0xaf88d065e77c8cc2239327c5edb3a432268e5831`, 6 decimals (matches the pinned `TRUSTED_ROUTE_TOKEN_IDENTITIES`). USDT0 is listed separately and never substituted. |
| Provider pair Lightning → 42161 | min 356 sats, max 20,000,000 sats, fee 0.5 % (same as Polygon) |
| Exact-output quote 0.30 USDC | `net_target_amount` = 300000 exactly; 429 sats net; `network_fee` 7, `gasless_network_fee` 0 |
| Exact-output quote 5.00 USDC | exact; 7105 sats net; `gasless_network_fee` 0 |
| `tests/quotes-multiroute.test.ts` (live provider) | 18/18 with both route tokens configured |
| `arb1.arbitrum.io/rpc` (Offchain Labs) | chainId 0xa4b1; `finalized` tag served; `eth_getLogs` on the pinned HTLC works; finalized trails head by **~1209 s (~20 min)** |
| `arbitrum-one-rpc.publicnode.com` | HTTP 403 from this network |
| `arbitrum.drpc.org` | timeout |

## Gasless claim path (SDK `@lendasat/lendaswap-sdk-pure` 2.7.0 via `@satora/swap` 1.7.2)

For a Lightning → Arbitrum swap whose target (USDC) differs from the HTLC
asset (tBTC on 42161), the SDK classifies the claim as an *Arbitrum hub claim
with a DEX leg*. `claimViaGasless` then publishes a **sponsored ERC-4337
UserOp** (Kernel smart account owned by the swap's claim key) through the
SDK's built-in AA config: `ClientBuilder.build()` uses
`aa: this.#aa ?? defaultAaConfig()` (Alchemy Arbitrum bundler + Satora
paymaster policy, both shipped inside the SDK). The recipient needs no ETH.

- If the sponsored UserOp fails for a DEX claim, the SDK **throws** (no
  wallet-paid fallback). Thence records an unknown claim outcome and
  resolves it only through verification (existing P3/A3b behaviour).
- The result's `txHash` is the bundle transaction hash
  (`receipt.receipt.transactionHash`). Thence's settlement verifier matches
  ERC-20 `Transfer` logs by token + destination and never filters on
  `tx.to`/`from`, so an EntryPoint-routed claim verifies unchanged.
- No CSP restricts browser `connect-src`, so the webview can reach the bundler.

**Gasless status: UNVERIFIED.** The path exists by design and quotes report
`gasless_network_fee: 0`, but a real sponsored Arbitrum claim has never been
executed. Paymaster sponsorship is a third-party dependency Thence cannot
check read-only.

## Timing and the claim deadline

The deadline is Satora's `evm_refund_locktime` (≈ swap creation + 1 h,
validated at bind to (10 min, 6 h] and before invoice expiry).

| Phase | Polygon | Arbitrum |
|---|---|---|
| Funding gate before Finish delivery | 32 confirmations (~70 s) | covered by L1 `finalized` (~20 min) |
| Delivered after claim | `finalized` (~minutes) | L1 `finalized` (~20 min) |
| Claim window left after funding gate | ~55 min | ~35 min (less if L1 batch posting lags) |

Unchanged server gates (A2/A3): no claim inside the last 5 min
(`DEADLINE_TOO_CLOSE`), funding must be in finalized ancestry, the HTLC
lifecycle must be ACTIVE on the pinned contract `0x6c38…6748`, refund and
expiry closure need finalized SwapKey evidence.

## What this slice changed

- `claim-intent`: on Arbitrum the funding wait returns
  `FUNDING_NOT_CONFIRMED` with `details: { finality: "l1", network: "Arbitrum" }`
  and honest copy (no "N of 32 confirmations").
- Client: one Finish-delivery tap keeps waiting through L1 finality (30 s
  cadence, 45 min upper bound; the server's deadline refusal still ends it).
  Polygon keeps 8 s / 4 min.
- Progress, timeline and refund/delivered copy name the route's network and
  its expected wait. Polygon wording is unchanged.
- Handoff authorization refuses `usdc-arbitrum` with `ROUTE_NOT_VERIFIABLE`
  unless a trusted `42161` RPC is configured, so no payment can start that
  Thence could never finish or prove.

Selection in the UI already follows `/api/routes/public`: the network shows
as selectable only where `THENCE_ENABLED_ROUTES` and `THENCE_ROUTE_TOKENS_JSON`
include `usdc-arbitrum`. No code enables it anywhere.

## Before a supervised mainnet canary (each needs owner approval)

1. Staging: add `usdc-arbitrum` to `THENCE_ENABLED_ROUTES`, its token to
   `THENCE_ROUTE_TOKENS_JSON` and `"42161":"https://arb1.arbitrum.io/rpc"` (or a
   keyed provider) to `THENCE_EVM_RPCS_JSON`; confirm `/api/routes/public`
   reports `live`. Staging keeps `THENCE_PAYMENTS_MODE=off`.
2. Choose the production Arbitrum RPC: the public endpoint is rate-limited;
   the claim and verification paths call it every 30 s per waiting payment.
3. Ask Satora to confirm the Arbitrum paymaster policy sponsors Thence's
   claims and the expected `evm_refund_locktime` for Lightning → 42161.
4. Confirm Nimiq Pay keeps the Lightning payment in flight for ~25 min
   (funding finality + claim) without timing out.
5. Production canary in **pilot** mode only (allowlisted owner wallet,
   minimum amount ≈ 0.30 USDC), with the route enabled for the canary window
   and removed afterwards (`THENCE_ENABLED_ROUTES` rollback).
6. Pass criteria: quote token/chain match; claim lands via sponsored UserOp
   with no ETH at the destination; proof recorded `finalized` only after the
   L1-finalized block covers the receipt; receipt and public proof match the
   on-chain Transfer; Polygon payments unaffected.
7. Separately authorized refund drill (let one minimum-amount swap pass its
   deadline unclaimed) to prove `REFUNDED` resolution on Arbitrum.
