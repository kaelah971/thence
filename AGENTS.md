<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Thence project notes

- Verify: `npm test` (live Neon dev DB, ~8 min), `npm run typecheck`, `npm run lint`, `npm run build`. Never reset/truncate Neon.
- Focused suites: `npx vitest run tests/<file>.test.ts`. Live-handler tests dispatch the browser client to real route handlers (see `tests/f3-data.test.ts`, `tests/f32-requests-quotes.test.ts`); mock Satora via `setSatoraFetchersForTests` + `vi.spyOn(await getSatoraClient(), "getQuote")`.
- Local quoting: `.env` enables only `usdc-polygon` with the provider-verified token in `THENCE_ROUTE_TOKENS_JSON`. Check `GET /api/routes/public` after changing route config.
- Browser QA: headless Chromium against `next dev` can loop on HMR reloads; screenshot against `npm run build && npm run start` instead.
- Money honesty: quotes are Lightning sats, never NIM; no NIM rate exists. Swipe/review never creates transfers, invoices or swaps until F4.
