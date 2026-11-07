# Thence: capability evidence (verified vs. off vs. planned)

Status as of 2026-11-06. Every claim made in the demo or submission must map to a row below.

## Legend

| Level | Meaning |
|---|---|
| **VERIFIED-MAINNET** | Done with real funds on mainnet; on-chain record exists |
| **VERIFIED-TEST** | Covered by automated tests in CI (integration against a test DB, or E2E with simulated host/provider/chain) |
| **IMPLEMENTED-OFF** | Built and tested, but disabled in production |
| **NOT BUILT** | Roadmap only. Don't claim it. |

## Capability matrix

| Capability | Level | Evidence |
|---|---|---|
| Nimiq wallet sign-in in Nimiq Pay (SDK `sign`) | VERIFIED-MAINNET | Used for the 2026-11-05 payment; `tests/auth.test.ts` |
| NIM balance on Home (SDK `getBalance`) | VERIFIED-TEST + device use | `tests/f6-balance.test.ts` |
| Live exact-receive quote, USDC on Polygon | VERIFIED-MAINNET | 2026-11-05 quote → swap of 380 sats for 300000 atomic |
| Recipients, wallets, verification badge | VERIFIED-TEST | `tests/recipients.test.ts`, verification tests |
| Payment request links `/r/:id` | VERIFIED-TEST | `tests/requests.test.ts`, `tests/f32-requests-quotes.test.ts` |
| NIM → Lightning → Satora → **USDC on Polygon**, delivered | **VERIFIED-MAINNET** (1 supervised payment) | See below |
| 256-confirmation settlement proof + receipt | VERIFIED-MAINNET | Proof `evm_erc20_transfer`, `confirmations-256` |
| Server reconciler (Hermes, every 2 min) | VERIFIED-MAINNET | Wrote `DELIVERED` for the 2026-11-05 payment; reconciles every live payment since |
| Refund / expiry recovery path | VERIFIED-MAINNET (incident) + TEST | 2026-11-02 incident fixture `tests/fixtures/incidents-2026-11-02.json` |
| Full approve → fund → Finish delivery → Delivered UI | VERIFIED-TEST (E2E, WebKit + Chromium) | `e2e/payment.e2e.ts`, screenshots in `docs/pr-assets/ux-mobile-payment-progress/` (simulated data) |
| Public payment mode (any wallet, any provider-allowed amount) | **VERIFIED-MAINNET** (live since 2026-11-06 21:23Z; first public payment `1dfd7782…` delivered) | `docs/PUBLIC_PAYMENTS.md`, `tests/public-payments-mode.test.ts`. Production mode is `off`. |
| Emergency switch | VERIFIED-MAINNET | Switched on and off around the 2026-11-05 payment; ENABLED for public payments since 2026-11-06 |
| USDT routes; Arbitrum / Ethereum / Base routes | IMPLEMENTED-OFF | In `src/domain/routes.ts`, not enabled or token-verified in production |
| Thence service fee | NOT BUILT | None is charged |
| Push notifications, multi-device recovery | NOT BUILT | — |

## The mainnet payment (2026-11-05, transfer `2c2432af…`)

| Fact | Value |
|---|---|
| Paid | about 1,000 NIM from Nimiq Pay (owner's screen) |
| Swap | Lightning → Polygon, 380 sats |
| Funding tx | mined about 41 s after the quote, status 1 |
| Claim (delivery) tx | mined about 97 s after the quote, status 1 |
| Token | native USDC on Polygon `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` |
| Received | ≥ the 300000 target (0.30 USDC); the recipient received slightly more, under 0.001 USDC |
| Finality | 256 confirmations, the policy then (about 8 minutes) |
| Independent cross-check | Two RPC providers agree: a single incoming transfer |

The 7-step audit trail and the full analysis are in
[`../PILOT_2026-11-05_FIRST_DELIVERY.md`](../PILOT_2026-11-05_FIRST_DELIVERY.md).

**Privacy.** Wallets, transaction hashes, block numbers, exact on-chain amounts and absolute
timestamps are deliberately omitted (owner decision; removed for the public release on
2026-11-07). Any of them would let an explorer identify the owner's wallet. The full evidence is
in operator records and can be shown privately to judges on request. No Polygonscan link or
explorer page is published, and none appears in the video.

## First public-mode payment (2026-11-06, transfer `1dfd7782…`, served from the Hermes VPS)

| Fact | Value |
|---|---|
| Mode | `public` (no allowlist, no pilot caps), emergency switch ENABLED |
| Quote | 0.30 USDC on Polygon for 402 sats |
| Timeline (relative to the quote) | Nimiq Pay approval +27 s → provider funded +52 s → claim authorized +2 min 14 s → **Delivered +10 min 02 s** (reconciler on the VPS) |
| Received | ≥ the 300000 target, native USDC, chain 137 (slightly more than the target) |
| Proof | `evm_erc20_transfer`, `confirmations-256` (before the finality change) |

Wallets, hashes, block numbers, exact amounts and absolute times are deliberately omitted (operator records only).

**Changes since this payment** (2026-11-07, verified before activation):
- **One-tap Finish delivery** (PR #46): the tap waits automatically for the 32 funding
  confirmations, showing "N of 32".
- **Polygon finalized-tag settlement** (PR #47, active 08:39Z): Delivered is written seconds after
  the claim instead of about 8 minutes later. The evidence is in `docs/POLYGON_FINALITY.md`.
- **Expected end-to-end time:** about 2 minutes from approval to Delivered.

## Honest wording to use

- ✅ "Delivered a real NIM → USDC payment on Polygon mainnet, verified on-chain with 256
  confirmations."
- ✅ "Payments are live for any Nimiq Pay wallet; a payment completes in about two minutes."
- ✅ "Delivered only after the USDC transfer is verified on-chain at Polygon finality."
- ❌ Don't say "live for everyone", "supports USDT", "supports Base/Arbitrum", "instant", or
  "zero fees".
- ❌ Don't present the simulated E2E screenshots as a real payment. Label them "simulated test
  environment".
