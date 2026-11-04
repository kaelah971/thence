# Browser E2E (P7) — what it proves, and what it does not

`npx playwright test` (Chromium desktop, Chromium Pixel 7, WebKit iPhone 14).

## What is real

- The Thence **production build** (`next build` into `.next-e2e`, payment and
  claim flags on), served by `next start`.
- The Thence **backend**: every route handler, session auth with real ed25519
  signatures, pilot gates, quotes, prepare/attach/authorize, handoff reports,
  reconciliation, P3 claim authorization (incl. on-chain funding + unspent
  checks), settlement verification, audit trail.
- The **isolated TEST database**, proven by the S0 anchor (`__thence_test_anchor`,
  project empty-wildflower-93415146) before anything starts; production is
  refused by identity, not by hostname.
- The **browser Satora SDK** (`@satora/swap`): it really generates the preimage
  and keys, stores them in the page's IndexedDB, reads them back, and performs
  the gasless claim (signing the redeem digest and revealing the preimage).
- The UI: every step is a click/tap/keystroke on the real screens.

## What is SIMULATED (test adapters, clearly labelled)

| Boundary | Simulation | File |
|---|---|---|
| Nimiq Pay host | `window.nimiq` injected before page scripts: `sign` uses an ephemeral test wallet; `payLightningInvoice` records the invoice and returns `{hash, swapId}` (or rejects/hangs on request). Visibility/focus/pageshow events simulate switching to Nimiq Pay and back. | `e2e/harness.ts` |
| Satora API | Local HTTP(S) service with the same paths and JSON shapes, from captured **public read-only** responses (`e2e/fixtures/*`) and the real 2026-11-02 `getSwap`. Swaps are created from the SDK's own request; the gasless claim endpoint checks `sha256(preimage) == hash_lock`. | `e2e/mock-services.ts` |
| Polygon RPC | Local JSON-RPC with viem-compatible receipts/blocks/logs: HTLC fund event (hash lock + deadline in data word 2), a synthetic redeem event, SwapRefunded, and the USDC `Transfer` evidence fed by the test. | `e2e/mock-services.ts` |
| Nimiq RPC | Balance reported unavailable (display only). | `e2e/mock-services.ts` |

All other outbound requests from the page are aborted; the server's external
URLs all point at the simulator. The simulator's HTTPS listener uses a
run-only self-signed certificate trusted only by the E2E server process
(`NODE_EXTRA_CA_CERTS`) — Thence's "RPC must be https" guard stays on.

## Differences from production that remain

- The E2E server runs with `NODE_ENV=test` on `http://localhost`, which relaxes
  exactly two production-only checks: the https/non-loopback origin rule and
  the cookie `Secure` flag. (Both are unit-tested in `tests/env.test.ts` and
  `tests/auth.test.ts`.)
- **Nimiq Pay is not exercised.** The real host's payment sheet, its own
  Lightning payment, its timeouts, its webview lifecycle (iOS suspension,
  process kill, storage eviction) and its NIM HTLC refund are not tested.
  WebKit + an iPhone viewport is the closest available engine, not the app.
- **Satora is not exercised.** Real pricing, real hold invoices, real HTLC
  funding latency, the real gasless relayer, DEX routing and real failure
  modes are represented only by captured shapes and scripted behaviour.
- **Polygon is not exercised.** Real finality, reorgs, RPC rate limits and the
  real HTLC/coordinator contracts are not touched; the redeem event topic is
  synthetic (Thence only needs "any non-fund event" for the unspent check).
- Server clock is real; deadline-expiry UI cases move only the page clock.

These tests therefore prove **how Thence behaves given those external
behaviours** — not that the real wallet, provider or chain behave that way.
A controlled real payment is still required for that.

## Safety

Nothing here can move money: there is no real wallet key, no real invoice,
no real swap and no network path to Satora, Lightning, Polygon or Nimiq.
The ephemeral E2E owner and everything it created are deleted from the TEST
database at teardown; the TEST database pilot switch is restored.
