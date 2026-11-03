<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Thence project notes

- Verify: `npm test` (live Neon TEST project, anchor-proven, ~8 min), `npm run typecheck`, `npm run lint`, `npm run build`. Never reset/truncate Neon.
- Focused suites: `npx vitest run tests/<file>.test.ts`. Live-handler tests dispatch the browser client to real route handlers (see `tests/f3-data.test.ts`, `tests/f32-requests-quotes.test.ts`); mock Satora via `setSatoraFetchersForTests` + `vi.spyOn(await getSatoraClient(), "getQuote")`.
- TEST DATABASE ISOLATION (F6.2.1, critical): live integration tests run ONLY with an explicit `THENCE_TEST_DATABASE_URL` pointing at the isolated test database (see `tests/test-db.ts`). A generic `DATABASE_URL` NEVER authorizes live tests. Never point `THENCE_TEST_DATABASE_URL` at production; the guard refuses same-target config. Never run `npm test` without the test URL configured — live suites skip safely and pure tests still run.
- PRODUCTION DATABASE SEPARATION (S0, critical): local `.env` `DATABASE_URL` targets the anchored non-production test project. The production connection string lives ONLY in `~/.thence/production.env` (outside the repo, never auto-loaded). `npm run dev|start|db:migrate|db:push|db:studio` run `scripts/assert-nonprod-db.ts` first and refuse any target that is not localhost or anchored (`__thence_test_anchor`), or that matches the production file (pooler-normalized). Vitest proves the test DB identity once (`tests/global-setup.ts`) and scrubs `DATABASE_URL` from workers without proof. Production pilot switch: `npx tsx scripts/pilot-switch.ts <cmd> --production [--yes]` only.
- P4 EXPIRED_UNFUNDED (critical): `RECONCILING → EXPIRED_UNFUNDED` happens ONLY via `POST /api/transfers/:id/close-expired` → `src/lib/expiry-resolution.ts` (fresh provider identity + expiry, no EVM tx ids, no recorded movement/mismatch/EVM proof/NIM funding, pinned HTLC, finalized on-chain no-activity scan; commit under the transfer lock with a terminal-once `transfer_transitions` audit row). The planner only reports `evidence-gated-close`; reconciliation never applies it. Copy must never call it a NIM refund. Production rollout requires migration 0015 (operator, explicit approval).
- P1 PAYMENT TRACKING: exactly one lifecycle driver per (owner, transfer) — `src/ui/lib/payment-tracker.ts` (shared, ref-counted, coalesced, abortable, backoff 3→30 s, 15 s cap pre-funding, 60 s after 429, paused while hidden and woken by visibility/focus/pageshow/online/`kickPaymentTracker`). Never add another polling loop; subscribe via `useSettlement().track`. The tracker never claims.
- Rendered UI tests: `*.test.tsx` with `// @vitest-environment jsdom` + React Testing Library; fixture-backed fake API in `tests/ui/fake-api.ts`; real redacted incident evidence in `tests/fixtures/incidents-2026-11-02.json`. `it.fails` marks REQUIRED behavior awaiting P1–P6 — remove the marker in the fixing change.
- Local quoting: `.env` enables only `usdc-polygon` with the provider-verified token in `THENCE_ROUTE_TOKENS_JSON`. Check `GET /api/routes/public` after changing route config.
- Browser QA: headless Chromium against `next dev` can loop on HMR reloads; screenshot against `npm run build && npm run start` instead.
- `npm run start` runs with `NODE_ENV=production`, which requires an https `THENCE_APP_ORIGIN`; set it per-process for local QA (e.g. `THENCE_APP_ORIGIN=https://paywiththence.vercel.app`).
- NIM balance (F6): host `getBalance` first (compact-address retry), then `GET /api/me/balance` (session address only, `THENCE_NIMIQ_RPC_URL` `getAccountByAddress`). Older Nimiq Pay hosts don't inject `getBalance`. Mock the RPC with `setNimiqRpcTransportForTests`. USDT balances aren't readable; the USDT card says so.
- CSS Modules scope `animation-name`, so global `th-*` keyframes from tokens.css don't resolve inside `*.module.css`; define local keyframes.
- Money honesty: quotes are Lightning sats, never NIM; no NIM rate exists. Swipe/review never creates transfers, invoices or swaps until F4.
