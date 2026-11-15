# Arbitrum native USDC — pilot readiness

Route `usdc-arbitrum`: NIM → Lightning → Satora → native USDC on Arbitrum One.

**Status (2026-11-15): code-ready for a supervised pilot, still disabled in
production.** Production `/api/health` reports `enabledRoutes: ["usdc-polygon"]`.
No real-money Arbitrum payment, claim or refund has been made. Enabling it is
an owner-only environment change (see the end of this document).

## Read-only mainnet evidence (2026-11-15, `scripts/probe-arbitrum-route.ts`)

Nothing was created: no transfer, swap, invoice or signature. Only provider
read endpoints and read-only JSON-RPC were called.

| Check | Result |
|---|---|
| Provider catalogue, chain 42161 | exactly one USDC listing, `0xaf88d065e77c8cc2239327c5edb3a432268e5831`, 6 decimals; equals the code trust anchor `TRUSTED_ROUTE_TOKEN_IDENTITIES["usdc-arbitrum"]` |
| Bridged USDC.e `0xff970a61…5cc8` | not listed by the provider; refused by the resolver even if configured. On-chain it **also reports the symbol `USDC`**, so only the exact address separates the two tokens |
| Native USDC on-chain | `name()` = USD Coin, `symbol()` = USDC, `decimals()` = 6 |
| Pair Lightning → 42161 | min 356 sats, max 20,000,000 sats |
| Exact-output quotes | $0.30 → 466 sats (9 fee), $1 → 1,540, $5 → 7,676, $25 → 38,364; `netTarget` exact each time |
| `eth_chainId` | 42161 |
| Pinned HTLC `0x6c38bf44…6748` | has code: 5,862 bytes, codehash `0xdb7820e0…c45f` |
| `finalized` tag | served; trails the head by 13–19 min (3,300–4,100 blocks) |
| Block rate | 3.56–3.58 blocks/s; 40,000 blocks ≈ 186 min |
| P4 window | lead 5 min + invoice + tail 60 min. Production invoices (58 swaps, read-only) last 44–90 min, so at most ≈ 155 min ≈ 33,300 blocks, inside the 40,000-block bound. The longest invoice that would still fit is ≈ 121 min |
| Production P4 scan (random hash, finalized 155-min window) | `NO_ACTIVITY` over 33,251 blocks in 28–30 s |
| Production claim lifecycle gate (random key) | decides `REJECTED`/`NONE` at a pinned head, every run |

**This is availability evidence, not proof of settlement.** No real Arbitrum
claim, sponsored UserOp, delivery proof or refund has been observed.

### RPC choice for `THENCE_EVM_RPCS_JSON["42161"]`

| Endpoint | Verdict |
|---|---|
| `https://arb1.arbitrum.io/rpc` (Offchain Labs) | **passes every check**: finalized tag, `eth_getLogs` over 2,000-block chunks ~3 h back, `eth_call` at a pinned historical block |
| `arbitrum-one-rpc.publicnode.com` | **unusable**: `eth_getLogs` beyond ~2.5 h returns HTTP 403 "Archive requests require a personal token", and state reads at the finalized height fail. P4 closes, refund discovery and the claim gate would all fail closed |
| `arbitrum.drpc.org` | timed out (2026-11-13) |

`arb1.arbitrum.io` is rate-limited and has no SLA. That is acceptable for a
low-volume pilot; a keyed provider should replace it before scaling.

## Gap fixed in this slice: moving-head refusals

Four Arbitrum verifiers required the chain head to be **identical** before and
after a multi-read check:

- the claim lifecycle gate (`verifyHtlcLifecycle`, required by every Finish delivery);
- P7 claim-retry evidence (`verifyHtlcUnspent`);
- P4 expired-unfunded no-activity proof (`verifyNoHtlcActivity`);
- refund discovery (`verifyHtlcRefund`).

Arbitrum adds a block about every 0.28 s, so that condition is never observed
on mainnet. Against `arb1.arbitrum.io` the claim gate refused 15 of 15 checks,
and the P4 scan refused every time. Every real Arbitrum payment would have
stopped at Finish delivery and waited for its refund. The deterministic tests
used a fixed head, which hid this.

Each check now pins the block its evidence is read **at** and anchors it:

- **Finalized-window scans (P4, refund discovery).** The whole window lies at
  or below the finalized block, so new head blocks cannot change it. After the
  scan, the finalized block must keep the same header hash, and finality must
  not regress or become unavailable.
- **Head reads (lifecycle, P7 retry).** The current state is read at the
  newest head observed after the finalized read, so a change landing mid-check
  is still seen. The header hash is read before and after, and must match. The
  head must not move backwards.

Everything else is unchanged:

- the L1-finalized requirement;
- the 40,000-block bound;
- SwapKey matching;
- the hash-wide P4 activity rule;
- every fail-closed path.

Polygon code paths are untouched. Two tests asserted the old rule, and the
tests that replaced them assert the new invariant both ways: an advancing head
is accepted; a reorged anchor, a head that moves backwards, and finality that
regresses are all refused.

## Gasless claim path (`@satora/swap` 1.7.2 / `lendaswap-sdk-pure` 2.7.0)

For Lightning → Arbitrum where the target (USDC) differs from the HTLC asset,
the SDK claims via a **sponsored ERC-4337 UserOp**, using a Kernel account,
the Alchemy Arbitrum bundler and the Satora paymaster, all built into the SDK.
The recipient needs no ETH. If sponsorship fails, the SDK throws (no
wallet-paid fallback), and Thence records an unknown claim outcome that only
verification resolves. Settlement matching sums ERC-20 `Transfer` logs by
token + destination, so an EntryPoint-routed claim verifies unchanged.
**Gasless status: UNVERIFIED** until the canary.

## Timing and the claim deadline

The claim deadline is Satora's `evm_refund_locktime`. In production it is 59.9–60.0 min after
swap creation (58 swaps).

| Phase | Polygon | Arbitrum |
|---|---|---|
| Funding gate before Finish delivery | 32 confirmations (~70 s) | L1 `finalized` (13–20 min) |
| Claim window left after the funding gate | ~55 min | ~35 min, less if L1 batch posting lags |
| Delivered after claim | `finalized` (minutes) | L1 `finalized` (~20 min) |

Server gates:

- no claim inside the last 5 min (`DEADLINE_TOO_CLOSE`);
- funding in finalized ancestry;
- HTLC lifecycle ACTIVE on the pinned contract;
- refund and expiry closure need finalized SwapKey evidence;
- `ROUTE_NOT_VERIFIABLE` refuses a handoff on a route without a trusted RPC for its chain.

On the client, one Finish-delivery tap waits through L1 finality (30 s cadence,
45 min bound).

## Delivery proofs

- **Full delivery.** Public proofs for `usdc-arbitrum` require chain 42161,
  the native USDC contract and `finalized`.
- **Short delivery.** R7 `DELIVERED_SHORT` public proofs are Polygon-only by
  design. An Arbitrum short delivery is still verified and receipted
  privately, but it is not published.

## Owner action to enable the pilot (production.env, owner-only)

Do these only after this PR is merged and deployed with the route still disabled.

1. Run the canary from Hermes or the operator PC:
   `npx tsx scripts/probe-arbitrum-route.ts --rpc https://arb1.arbitrum.io/rpc`.
   Every line must PASS.
2. In `/etc/thence-web-prod/production.env`, keep a rollback copy, then add:
   - `THENCE_EVM_RPCS_JSON`: `"42161":"https://arb1.arbitrum.io/rpc"`, keeping `"137"`;
   - `THENCE_ROUTE_TOKENS_JSON`: `"usdc-arbitrum":"0xaf88d065e77c8cc2239327c5edb3a432268e5831"`, keeping `usdc-polygon`;
   - `THENCE_ENABLED_ROUTES`: `usdc-polygon,usdc-arbitrum`.

   Install it with `thence-env-install`, then restart `thence-web-production`
   at a clean reconcile boundary.
3. Check that `/api/routes/public` shows `usdc-arbitrum` as `live` and
   `usdc-polygon` unchanged, and that `/api/health` lists both.
4. Run a supervised canary from the owner wallet at the minimum (~$0.30).

   Pass criteria:
   - the quote's token and chain match;
   - the claim lands via a sponsored UserOp, with no ETH at the destination;
   - the proof is recorded `finalized` only after L1 finality;
   - the receipt and public proof match the on-chain Transfer;
   - Polygon payments are unaffected.
5. Roll back by removing `usdc-arbitrum` from `THENCE_ENABLED_ROUTES` **only**.
   Keep its token and the `"42161"` RPC entry: reconciliation, claim, close
   and refund checks for payments already in flight resolve the route through
   them. Removing either would leave those payments unverifiable, which fails
   closed.
6. Separately authorized: a refund drill (one minimum swap left unclaimed past
   its deadline) to prove `REFUNDED` on Arbitrum.
