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
| Server reconciler (Hermes, every 2 min) | VERIFIED-MAINNET | Wrote `DELIVERED` at 09:38:51Z on 2026-11-05 |
| Refund / expiry recovery path | VERIFIED-MAINNET (incident) + TEST | 2026-11-02 incident fixture `tests/fixtures/incidents-2026-11-02.json` |
| Full approve → fund → Finish delivery → Delivered UI | VERIFIED-TEST (E2E, WebKit + Chromium) | `e2e/payment.e2e.ts`, screenshots in `docs/pr-assets/ux-mobile-payment-progress/` (simulated data) |
| Public payment mode (any wallet, any provider-allowed amount) | **IMPLEMENTED-OFF** | `docs/PUBLIC_PAYMENTS.md`, `tests/public-payments-mode.test.ts`. Production mode is `off`. |
| Emergency switch | VERIFIED-MAINNET | Switch ENABLED 09:26:48Z → DISABLED 09:30:58Z on 2026-11-05 |
| USDT routes; Arbitrum / Ethereum / Base routes | IMPLEMENTED-OFF | In `src/domain/routes.ts`, not enabled or token-verified in production |
| Thence service fee | NOT BUILT | None is charged |
| Push notifications, multi-device recovery | NOT BUILT | — |

## The mainnet payment (2026-11-05, transfer `2c2432af…`)

| Fact | Value |
|---|---|
| Paid | ≈ 985.45 NIM from Nimiq Pay (owner's screen) |
| Swap | Lightning → Polygon, 380 sats |
| Funding tx | block **96777064**, 09:30:52Z, status 1 |
| Claim (delivery) tx | block **96777101**, 09:31:48Z, status 1 |
| Token | native USDC on Polygon `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` |
| Received | **300394 atomic** (0.300394 USDC) vs target 300000 |
| Finality | 256 confirmations at block 96777357 (09:38:12Z) |
| Independent cross-check | Tenderly and PublicNode agree: a single incoming transfer, balance 0 → 300394 |

The 7-step audit trail and the full analysis are in
[`../PILOT_2026-11-05_FIRST_DELIVERY.md`](../PILOT_2026-11-05_FIRST_DELIVERY.md).

**Masking.** The full transaction hashes and the recipient wallet are kept in operator records,
not in the repository. Publishing the claim transaction hash would reveal the owner's wallet.
**The owner decides** whether to include a Polygonscan link in the submission. With the block
number and the USDC contract, the transaction can be found anyway.

## Honest wording to use

- ✅ "Delivered a real NIM → USDC payment on Polygon mainnet, verified on-chain with 256
  confirmations."
- ✅ "Public payments are implemented and tested, and are switched off in production while we
  finish the hosting migration and the safety reviews."
- ❌ Don't say "live for everyone", "supports USDT", "supports Base/Arbitrum", "instant", or
  "zero fees".
- ❌ Don't present the simulated E2E screenshots as a real payment. Label them "simulated test
  environment".
