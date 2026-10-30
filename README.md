# Thence — recipient-first payments inside Nimiq Pay

> Pay from what you have. They receive what they use.

Thence is a Nimiq Pay Mini App for the Nimiq Mini Apps Competition (Cycle III, PAY category).
A sender pays with **NIM**; the recipient receives **exactly** the agreed amount of
**USDC/USDT** on their preferred network (**Polygon, Arbitrum, Ethereum, Base**).
Amounts are exact atomic units end to end — never floats, never a NIM-rate guess.

## The money flow

```
NIM (Nimiq Pay approval)
  → Lightning invoice (host-paid, exact sats incl. fees)
    → Satora swap
      → USDC/USDT delivered on the destination network
```

1. **Choose who** — pick a saved recipient (or a one-off wallet) and the receiving wallet.
2. **Set what they receive** — calculator entry in the destination asset (2 decimals for USDC/USDT).
3. **Review a live price** — `GET /api/quotes` binds the exact atomic target; the UI shows
   *Lightning needed* in sats and states plainly that sats are not the NIM cost.
4. **Swipe to approve** — preparation persists recovery material (vault binding) first.
5. **Confirm in Nimiq Pay** — the host pays the exact authorized invoice; Thence never auto-invokes.
6. **Track to delivered** — bounded reconcile + verify-settlement; **Delivered** renders only from
   the backend-confirmed immutable receipt, with on-chain proof link.

Payment requests work the same way in reverse: create a link (`/r/:publicId`), share it, and the
payer lands on a prefilled review with a locked amount. Expired/cancelled links are unpayable
and say so.

## Features

- Guided onboarding (name → Nimiq wallet connect → home), reconnect flow, preview fixtures
- Recipients with multiple wallets, preferred wallet, and backend-confirmed verification badges
- Send flow with precision-guarded calculator, live availability, and quote expiry/refresh
- Payment requests: create, share, list/filter, cancel; signed-out public pages
- Activity list with status pills (preparing / checking / on its way / delivered / needs attention)
- Recovery vault with readback checks, idempotent handoff reports, and "do not resend" discipline

## Architecture

- **Next.js 16** (App Router, Turbopack) — `app/` routes, `src/ui/` screens and components
- **API** — `app/api/*`: session/challenge/verify, recipients + destinations + verification,
  requests, quotes, transfers (prepare/attempt/handoff-result/reconcile/verify-settlement/receipt)
- **DB** — Drizzle ORM + PostgreSQL (Neon for hosted/dev) — `src/db/schema.ts`, versioned SQL in
  `src/db/migrations/` (0000–0013, journal-checked)
- **Domain** — `src/domain/`: exact money math, canonical route registry, transfer state machine
- **Providers** — Satora swaps via `@satora/swap`; Lightning capability via the Nimiq host provider
- **Gates** — `src/ui/lib/payment-gate.ts` / `claim-gate.ts`: every native invocation or claim
  requires an explicit controlled-test flag **plus** session, authorization, vault match, live
  invoice, and explicit user action. Both flags are **OFF** in this release.

## Installation and configuration

Prerequisites: Node.js ≥ 20, PostgreSQL (see `docs/LOCAL_DB.md`).

```bash
cp .env.example .env   # placeholders only — never commit real credentials
npm install
npm run db:migrate
npm run typecheck && npm run lint
npm run dev            # GET /api/health
```

Key configuration (`src/lib/env.ts` is the validator; names only, no values here):

- `DATABASE_URL` — `postgresql://` connection string (required)
- `THENCE_ENABLED_ROUTES` — comma-separated route ids (all disabled by default)
- `THENCE_ROUTE_TOKENS_JSON` — verified EVM token addresses per route (empty = non-quoteable, by design)
- `THENCE_APP_ORIGIN` — trusted `https://` origin for absolute share links; **required in production**
  (localhost/loopback rejected); empty in development means relative links
- TTLs/rate limits — quote, challenge, session, request lifetimes and per-minute guards
- `NEXT_PUBLIC_THENCE_ENABLE_PAYMENT` / `NEXT_PUBLIC_THENCE_ENABLE_CLAIM` — **leave unset**
  (controlled-test only; no funded execution while unset)

## Local development

- `npm run dev` — wallet auth needs the Nimiq Pay host or the development preview (`/app/preview`)
- Preview fixtures are clearly labelled fictional and never sign in or call authenticated APIs
- Tests mock Satora via `setSatoraFetchersForTests` + `vi.spyOn(await getSatoraClient(), "getQuote")`;
  live-handler tests dispatch the browser client to real route handlers

## Security and recovery model

- Nimiq wallet authentication (Ed25519 challenge of the official prefixed message), opaque
  SHA-256-hashed sessions on HttpOnly cookies (`SameSite=Lax`, `Secure` in production)
- Fixed-window DB-backed rate limits, including abuse ceilings that survive forged headers
  (edge rate limiting / WAF still required in production — see `docs/OPERATIONS.md`)
- Exact-amount binding: quotes, attempts, and swaps must match the authorized atomic target
- Vault binding per transfer + owner + swap, with readback before any claim; single-attempt
  discipline with verify-after-claim; unknown outcomes converge via idempotent unknown-reports
- Recovery information is device-local; clearing device storage or losing the device loses it —
  the UI says so before continuing

## Known limitations

- **Payment and claim execution are OFF** (both controlled-test flags unset). Approval and
  finishing surfaces are wired but gated; reviewers see honest "paused in this preview" states.
- **No funded end-to-end run is claimed as verified in this release.**
- Production `next build` must be verified on the host (it was not runnable on the
  release-prep machine — see testing status).
- Responsive spot-checks at 360/768/1440px and short viewports remain to be completed on device.

## Testing status

- **464 tests passing, 0 failed** (`vitest run`, includes live Neon integration)
- `npm run typecheck` clean, `npm run lint` clean
- Production build: compile step succeeds; full `next build` type-check phase needs more RAM
  than the release-prep machine provides — **Vercel must verify the production compilation**

## License

MIT for Thence's original code — see [LICENSE](./LICENSE). Third-party dependencies
(`package.json`) and any platform artwork remain under their own terms and are not covered
by the MIT grant.
