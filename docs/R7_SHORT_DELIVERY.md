# R7 — Verified short deliveries

Incident: transfer `2b24ca8f-01f0-411c-84ca-749a2b6692ff` (Nov 14 2026). Requested
1,000,000 atomic USDC on Polygon; the finalized claim `0x45ba18c9…9006` credited the
recipient 999,556 (444 short, 0.0444%). The verifier correctly refused `DELIVERED`,
but `INVALID` is non-terminal, so the transfer sat in `CLAIMING` ("Verifying
delivery") and the reconciler logged `SETTLEMENT_INVALID` every 2 minutes.

## What changes

| Area | Change |
|---|---|
| State machine (`src/domain/transfers.ts`) | New terminal `DELIVERED_SHORT`, reachable only from `CLAIMING` / `SERVER_FUNDED`. `assertShortDeliveryEvidence` requires a destination tx, a bound-swap redeem and `0 < received < requested`. No edge to or from `DELIVERED`. |
| Verifier (`src/lib/settlement.ts`) | The existing `verifySettlementCore` is reused. A positive-but-short output is no longer rejected early: it must first pass the same reorg and finality checks, then `matchBoundSwapRedeem` (SwapRedeemed from the pinned HTLC the provider named, topic[1] = bound hash lock, topic[2] = SwapKey recomputed from the provider's HTLC terms + bound deadline). Only then is it committed, under the transfer advisory lock, as `DELIVERED_SHORT` with verdict `VERIFIED_SHORT`. The short/full decision is re-derived from the locked row. Every other failure keeps its existing verdict (zero output, wrong recipient/token, reverted, unfinalized, reorg, no/foreign redeem, unavailable identity). |
| Proof row | Same `transfer_proofs` row as a full delivery; `verified_amount_atomic` is the measured output. The quote amount is never stored as received. |
| Audit | One terminal transition, reason `SETTLEMENT_VERIFIED_SHORT`, evidence: requested, verified, shortfall, claim tx, block, log indexes, finality, `swapIdentity: BOUND_REDEEM_MATCH`. The redeem data (preimage) is never read or stored. |
| Replay / concurrency | A `DELIVERED_SHORT` transfer replays its stored proof (`VERIFIED_SHORT`); later receipts cannot re-decide it. Concurrent verifications converge on one transition. No claim, swap, payment or refund is ever initiated. |
| Reconciler | Counts `advanced → DELIVERED_SHORT` and `shortDeliveries` (absent when 0). |
| Consistency | New checks: `SHORT_WITHOUT_PROOF`, `SHORT_NOT_BELOW_REQUEST`, `DELIVERED_BELOW_REQUEST`. |
| Global Proof of Payments (`src/lib/global-proofs.ts`) | Publishes both outcomes with distinct statuses. `DELIVERED` keeps the pre-R7 rule (verified ≥ requested) and its records keep their exact pre-R7 JSON shape. `DELIVERED_SHORT` publishes only when 0 < verified < requested **and** the audited `SETTLEMENT_VERIFIED_SHORT` transition (`swapIdentity: BOUND_REDEEM_MATCH`) names the same claim tx, chain, amount, requested amount, shortfall and finality as the proof row. It is enforced in the SQL publication query and again in the serializer. All existing gates are unchanged: independent mainnet NIM source evidence, route/chain/canonical token, recipient = destination, finality policy, tx/hash formats, one proof row per transfer and the double-attribution guard. Short records add `destination.deliveryOutcome: "SHORT"` and `destination.shortfallAtomic`. |
| Public feed UI / client (`src/ui/lib/proofs-api.ts`, `ProofFeed.tsx`) | Accepts `DELIVERED_SHORT` only when requested − verified = shortfall > 0; rejects a `DELIVERED` record carrying a short marker or a below-request amount. Badge "Delivered — less than requested" (distinct colour); detail shows Requested, USDC received and Shortfall. There are no proof counters or metrics in the codebase, so nothing counts a short delivery as a full one. |
| Receipt API | Serves `DELIVERED_SHORT` receipts with `deliveryOutcome: "SHORT"`, `requestedAmountAtomic`, `verifiedAmountAtomic`, `shortfallAtomic`, and the Polygon proof link. Refuses if status and measured amount disagree. |
| UI | Pill/timeline/headline "Delivered — less than requested" (warn tone); receipts show "You asked to send", "They received", "Short by". Pilot spend counts it as actual spend. |

**Migration: none — checked against the live dev schema (= the 19 tracked
migrations production has):** `transfers.status` is `varchar(32)` with no CHECK,
enum or trigger (`DELIVERED_SHORT` is 15 chars); `transfer_transitions.to_status`
`varchar(32)`, `reason_code` `varchar(64)` (`SETTLEMENT_VERIFIED_SHORT` is 25), only
an `actor` CHECK (owner/reconciler/operator); `transfer_proofs.verified_amount_atomic`
is `text`.

## Why it was short (evidence, not tuning)

Both of today's claims call the Satora coordinator router
`0xdb76f29f1d04d1202f56a34549869b070dfcbff0` (`0xee2837cf`), which swaps the HTLC's
WBTC to USDC through Uniswap V3 `SwapRouter` `0xe592427a…1564` at claim time. The
calldata's minimum output is exactly 99% of the requested amount:

| Claim | Requested | Calldata min-out | Received |
|---|---|---|---|
| `0xdcef6ee9…` (0.30) | 300,000 | 297,000 | 300,542 (+0.18%) |
| `0x45ba18c9…` (1.00) | 1,000,000 | 990,000 | 999,556 (−0.044%) |

Thence does not build this calldata; Satora's server (`0x5ce278…ebac`) relays it.

**On-chain claim minimum vs. a minimum promised at quote time.** The 99% value is
an execution guard inside one claim transaction: it only makes *that* claim revert
if the DEX output is lower. It is not a promise made to the payer when the quote
was accepted — Thence's quote (`target_amount`) is what the user approved, and
nothing in the Satora quote response Thence consumes states a minimum. Today the
user is shown the requested amount only; an output between 99% and 100% is a
valid claim under Satora's terms but below what the user approved, which is
exactly what `DELIVERED_SHORT` discloses. A guaranteed minimum would have to come
from Satora at quote time (or Satora setting the claim minimum to the target).
So any output from 99% upward is a valid claim by the provider's own contract
terms, and short deliveries of up to 1% will recur. Nothing was changed to quoting,
slippage or limits. Prevention options, all needing Satora's input:

1. Ask Satora to set the claim minimum to the quoted target (true exact-receive) or
   to expose the min-out in the swap API so Thence can disclose it before approval.
2. If Satora confirms a fixed 1% floor, show "they'll receive at least 0.99 USDC"
   before approval. Overquoting by a guessed buffer is not implemented.

## Rollout (smallest safe procedure)

Preconditions: PR merged; `typecheck`, `lint`, `build`, the R7 suite and the
settlement / reconciler / consistency / UI suites green.

1. **No database step.** No migration is required.
2. **Deploy** with the documented Hermes flow: `git archive <merge>` → `scp` →
   `sudo -n -u thence-prod /opt/thence/bin/thence-deploy production /tmp/x.tgz`
   → restart only `thence-web-production`, right after a clean reconcile run.
   Rollback target: the current 2472830 release (`thence-deploy production rollback`).
3. **Expected effect on the incident**: on the first reconcile after the restart,
   `2b24ca8f` re-runs the normal verifier. Polygon still shows the finalized
   claim, so it moves `CLAIMING → DELIVERED_SHORT` with `shortDeliveries: 1` and
   `advanced: [{ to: "DELIVERED_SHORT" }]` in the reconciler log. No manual
   database write, claim or payment is involved; the incident's on-chain evidence
   is the input, untouched.
4. **Verify (read-only)**: transfer status `DELIVERED_SHORT`; proof
   `verified_amount_atomic = 999556`; one `SETTLEMENT_VERIFIED_SHORT` transition
   with `shortfallAtomic: "444"`; `/api/proofs` count goes from 6 to 7 — the
   six existing `DELIVERED` records byte-identical, plus one new
   `DELIVERED_SHORT` record with `shortfallAtomic: "444"` (the incident already
   has independent NIM source evidence); no `SETTLEMENT_INVALID` in later
   reconciler runs; the owner's receipt shows requested 1.00, received
   0.999556, short by 0.000444.
   *Outcome (2026-11-14):* deployed `3ceebc2` (release `20261114T134721Z`) at
   13:50:11Z; the first reconcile (13:52:12Z) moved `2b24ca8f` to
   `DELIVERED_SHORT`; Global Proof went 6 → 7 (new proof `ad0119c3`), the six
   existing records unchanged.
5. **Rollback** if anything differs: `thence-deploy production rollback` + restart.
   A `DELIVERED_SHORT` row written before rollback is inert on the old build:
   the old reconciler only selects its fixed `SERVER_RECONCILABLE` list, so it
   never touches the row, and nothing re-claims or re-pays it. The old UI drops
   unknown statuses (`toActivityItem` returns null), so the payment disappears
   from the owner's Activity until R7 is redeployed. Do not hand-edit the status
   back.
