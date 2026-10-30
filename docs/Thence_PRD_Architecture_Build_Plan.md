# Thence — PRD, Architecture and Build Plan

**Product:** Thence  
**Pronunciation:** `thens`  
**Descriptor:** Recipient-first cross-asset payments inside Nimiq Pay  
**Version:** 1.0 — locked product baseline for the Thence build  
**Competition:** Nimiq Mini Apps Competition — Cycle III, Pay category  
**Status:** Approved as an implementation blueprint; target architecture is not proof of shipped functionality  
**Companion document:** `Thence_Product_Idea.md` and `Thence_Seven_Things_Brand_and_Product_Scope.md`  
**Security rule:** Never include credentials, API keys, tokens, passwords, private keys, wallet addresses, connection strings or other secrets. Replace any encountered value with `[REDACTED]`.

> **Pay from what you have. They receive what they use.**

This document is an editable Markdown replacement derived from the supplied PRD/build-plan/architecture PDF. The original PDF remains unchanged.

## Claim-status legend

- **Shipped** — implemented and exercised in the current repository or test environment.
- **Target** — required or planned for the current Thence MVP.
- **Roadmap** — intentionally deferred beyond the competition cut.
- **Hypothesis** — requires user, route, economic or operational validation.

The source material reports a zero-funds spike and read-only route evidence. It also states that a real mainnet NIM-to-stablecoin settlement remains pending. This replacement does not convert planned architecture into a live-product claim.

# 1. Document status and build objective

## 1.1 Build objective

Build a production-shaped Nimiq Pay Mini App where a sender funds a transfer from NIM and the recipient receives an exact amount in a supported asset and network. Thence must preserve payment safety across reloads, ambiguous outcomes and multi-leg settlement.

## 1.2 Primary launch proof

The preferred first proof is:

> **NIM → USDT Polygon to a recipient, followed by a second supported route that proves the product abstraction is multi-network.**

The route is only presented as shipped after the current implementation produces valid quotes, safe handoff, destination evidence and a reproducible receipt.

## 1.3 Engineering constraints

- Create a new Thence repository and app surface; do not mutate or rename an unrelated existing project.
- Money does not pass through the Thence backend.
- Nimiq Pay owns user approval for NIM movement.
- Satora swap and recovery secrets remain client-side in supported persistent storage.
- An unknown outcome never becomes failure automatically.
- Route support is discovered and validated from current provider responses.
- No fake exchange rate or guaranteed conversion amount.
- No mainnet action occurs without deliberate native Nimiq Pay approval.
- No user address, secret, private key or seed material is written into this document or backend logs.

# 2. Product requirements

| Requirement | Priority | Acceptance target |
|---|---:|---|
| Show real NIM balance | P0 | Connected Nimiq Pay account and balance are visible; production mode has no mock balance |
| Indicative send-as selector | P1 | User can switch among enabled asset/network pairs and see a clearly labelled estimate |
| Exact-receive Send | P0 | User chooses recipient and destination amount; Thence obtains a valid route before handoff |
| Recipients | P0 | Create, edit, archive, select and Pay Again from saved beneficiary preferences |
| Request to Pay | P1 | Create a shareable request link/QR that pre-fills recipient, asset, network and amount |
| Recipient verification | P1 | Optional signed proof marks a destination as verified without blocking manual recipients |
| Activity | P0 | Transfers show durable user-facing status and can be resumed after reload |
| Cross-chain receipt | P0 | Delivered state exposes safe proof identifiers and destination settlement hash where available |
| Multi-route support | P0/P1 | USDT Polygon first; additional quote-proven routes behind the route registry and feature flags |

# 3. User stories and jobs

## 3.1 Sender

- As an NIM holder, I want to pay Daniel 50 USDC on Base without buying USDC myself.
- I want to save Daniel so I do not re-enter a network and destination each time.
- I want to know if a route is unavailable before approving any payment.
- I want to see whether a pending payment is still moving after reopening the app.
- I want the amount I enter to describe what Daniel receives, not an estimate of how much NIM I must calculate.

## 3.2 Recipient

- I want to specify what asset and network I accept.
- I want to create a request so the payer cannot accidentally choose the wrong chain.
- I want to verify my settlement destination so repeat payers receive a useful trust signal.
- I want a receipt showing what was delivered and where.

## 3.3 Jobs to be done

1. Pay a known person in the form they accept.
2. Pay a one-off request safely.
3. Repeat a previous payment without re-entering technical details.
4. Recover confidence after interruption, reload or provider delay.
5. Explain the completed payment to the recipient using one safe receipt.

# 4. Information architecture

## 4.1 Bottom navigation

### HOME

- NIM balance.
- Indicative send-as estimate.
- Send and Request actions.
- Recent recipients.
- Active and recent activity.

### SEND

- Choose recipient or new recipient.
- Exact receive amount.
- Quote and review.
- Native Nimiq Pay approval.
- Settlement status.

### RECIPIENTS

- Search and list.
- Add, edit and archive.
- Preferred asset, network and destination.
- Verification state.
- Payment history and Pay Again.

### ACTIVITY

- Pending.
- Delivered.
- Needs attention.
- Expired.
- Receipt detail and technical proof beneath the human summary.

### AVATAR / SETTINGS

- Account information.
- Payment preference profile.
- Request settings.
- Diagnostics and support.

## 4.2 Product-language rules

- Use **Pay with NIM**, not **Swap to**.
- Use **Send value as**, not **Owned balance**.
- Use **Recipient receives**, not **Output token**.
- Use **Approve in Nimiq Pay**, not a simulated approval button.
- Use **Checking payment — do not resend**, not **Failed** for unknown outcomes.
- Use **Delivered** only when destination evidence supports the state.

# 5. System architecture

## 5.1 System overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    NIMIQ PAY MINI APP                       │
│                                                             │
│  UI / State                                                 │
│  Home · Send · Recipients · Requests · Activity · Receipts  │
│       │                                                     │
│       ├── Nimiq Adapter ──> Nimiq Pay Provider              │
│       │      account/balance, approval, Lightning handoff    │
│       │                                                     │
│       ├── Route Engine ──> @satora/swap                     │
│       │      routes, quotes, swap creation, claim/status     │
│       │                                                     │
│       ├── Recovery Vault ──> IndexedDB                      │
│       │      SDK state, pending-transfer guards             │
│       │                                                     │
│       └── App API ─────────> Backend                        │
│                              profiles, recipients, requests  │
│                              transfer metadata, receipts     │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            v
┌─────────────────────────────────────────────────────────────┐
│ BACKEND — NOT IN THE MONEY PATH                             │
│ Next.js API / service layer + PostgreSQL                    │
│ wallet session · recipient book · request links · metadata  │
│ no swap secret · no private key · no custody                │
└─────────────────────────────────────────────────────────────┘

MONEY PATH — CLIENT CONTROLLED
NIM → Nimiq Pay → Lightning invoice → Satora → target chain → recipient
```

## 5.2 Architecture principles

1. **Nimiq Pay is the approval boundary.** Thence requests payment; it does not imitate native confirmation.
2. **The backend stores metadata, not money-moving secrets.**
3. **Recovery state is persisted before handoff.**
4. **Provider acknowledgement and destination delivery are different states.**
5. **Route availability is dynamic.** A route registry controls what can be selected.
6. **Unknown outcomes are recoverable states.** They do not silently become failed or paid twice.
7. **Exact receive is a destination promise only when the provider quote can support it.**

# 6. Recommended stack

| Layer | Target choice | Reason |
|---|---|---|
| Frontend | Next.js 16, React 19, strict TypeScript | Fast app structure and Vercel-ready deployment |
| Styling | Tailwind CSS v4 plus a small Thence token system | Fast implementation without a heavy component dependency |
| Nimiq | `@nimiq/mini-app-sdk` | Provider, account and Lightning handoff inside Nimiq Pay |
| Routing | `@satora/swap` | Live quote, swap lifecycle, supported route and recovery primitives |
| Client persistence | Satora IndexedDB storage plus app IndexedDB | Durable unfinished-swap recovery without backend custody |
| Backend database | PostgreSQL with Drizzle ORM | Relational fit for recipients, requests, transfers and receipts |
| Session | Nimiq wallet challenge → signed proof → HttpOnly session | No password account; wallet remains identity anchor |
| Testing | Vitest, React Testing Library and Playwright | Domain/state tests plus critical embedded flow E2E |

Supabase is an acceptable implementation alternative if speed or operational familiarity wins. The non-custodial architecture rule is more important than the vendor choice.

# 7. Domain modules

- `nimiqAdapter` — environment detection, account/balance, capabilities, Lightning payment handoff and cancellation/unknown normalization.
- `routeRegistry` — supported asset/network pairs, token metadata, direct versus bridged route flags and temporary availability.
- `quoteEngine` — route checks, limits, fees, exact-receive solver, quote age and indicative estimates.
- `transferOrchestrator` — one state machine controlling quote, swap creation, handoff, settlement and receipt.
- `recoveryVault` — client-persisted swap state, duplicate-handoff guard, resume and reconcile.
- `recipientBook` — saved beneficiaries, preferences, verification state and Pay Again defaults.
- `requestService` — create, open and expire payment requests and QR/share-link payloads.
- `receiptBuilder` — combines Nimiq payment identifiers, Satora swap ID and destination proof into one safe receipt.

# 8. Money-path sequence

1. User selects a saved recipient or creates one.
2. Recipient preference supplies asset, network and destination.
3. User enters the amount the recipient should receive.
4. `quoteEngine` validates route, limits, fee and quote freshness.
5. `transferOrchestrator` creates recovery state.
6. Satora returns a BOLT11 invoice or equivalent supported handoff context.
7. `recoveryVault` persists recovery-critical state before any payment handoff.
8. The Mini App requests `payLightningInvoice(invoice)` through Nimiq Pay.
9. The user deliberately approves using NIM in the native host dialog.
10. Nimiq Pay handles NIM-to-Lightning funding.
11. Satora observes funding and progresses the swap.
12. The client observes provider state and performs required claim/finalization when the route requires it.
13. Destination settlement is verified.
14. `receiptBuilder` marks the transfer `DELIVERED` only when evidence supports it.
15. The UI offers Share Receipt and Pay Again.

**Critical ordering:** Recovery-critical swap state must be persisted before step 8. A browser crash after funding must not orphan the payment.

# 9. Transfer state machine

```text
DRAFT
  |
  v
QUOTED --------------------------> QUOTE_EXPIRED
  |
  v
SWAP_CREATED
  |
  v
AWAITING_NIM_APPROVAL ----------> USER_CANCELLED
  |
  v
LIGHTNING_HANDOFF
  |   |  \----> OUTCOME_UNKNOWN ----> RECONCILING
  |                                |      |
  v                                |      +--> resume observed state
CLIENT_FUNDED <--------------------+
  |
  v
SERVER_FUNDED
  |
  v
CLAIMING
  |   |  \----> NEEDS_ATTENTION / RECOVERABLE
  v
DELIVERED
```

## 9.1 State rules

- Only verified destination settlement may enter `DELIVERED`.
- `OUTCOME_UNKNOWN` never transitions directly to `FAILED`.
- `OUTCOME_UNKNOWN` never opens a new payment for the same transfer.
- A stale quote cannot be silently reused.
- A single BOLT11 invoice receives one handoff attempt.

## 9.2 User-facing mapping

| Domain state | User-facing label |
|---|---|
| `QUOTED`, `SWAP_CREATED` | Ready to pay |
| `AWAITING_NIM_APPROVAL` | Approve in Nimiq Pay |
| `LIGHTNING_HANDOFF`, `CLIENT_FUNDED` | Payment approved / Converting |
| `SERVER_FUNDED`, `CLAIMING` | Sending |
| `OUTCOME_UNKNOWN`, `RECONCILING` | Checking payment — do not resend |
| `DELIVERED` | Delivered |
| `NEEDS_ATTENTION` | Needs attention |
| `QUOTE_EXPIRED` | Quote expired |

# 10. Exact-receive quote engine

The user’s input is the recipient amount. A provider may quote from source Lightning sats, so Thence needs a safe adapter that solves toward a target without pretending precision it does not have.

## 10.1 Algorithm target

1. Validate target route and provider minimum/maximum.
2. If the provider supports exact-output natively, use it.
3. Otherwise perform a bounded search over source sats using read-only quotes until the target amount meets a documented tolerance.
4. Include provider, network and bridge fees returned by the route.
5. Create the swap only from the final accepted quote context.
6. Keep Nimiq Pay as the source of truth for the exact NIM debit at approval.

## 10.2 Honest precision rule

The home-card estimate is indicative. The Send flow can promise the destination amount only when the current provider route can satisfy it. Thence cannot promise the exact NIM debit before Nimiq Pay provides the native approval amount.

## 10.3 Quote invalidation

Invalidate a quote when:

- its age exceeds the configured validity window;
- provider route availability changes;
- target amount falls outside current limits;
- fee context changes materially;
- destination/network validation fails;
- the user changes recipient, asset or network.

# 11. Route registry

```ts
type SettlementRoute = {
  id: string
  asset: 'USDT' | 'USDC' | 'BTC'
  network: 'Polygon' | 'Arbitrum' | 'Ethereum' | 'Base' | 'Lightning'
  targetToken?: `0x${string}`
  kind: 'satora-direct' | 'satora-cctp' | 'nimiq-lightning'
  enabled: boolean
  quoteable: boolean
  min?: bigint
  max?: bigint
  lastCheckedAt?: string
}
```

## 11.1 Initial target registry

| Route | Kind | Launch posture |
|---|---|---|
| USDT Polygon | `satora-direct` | Primary when live quote and settlement proof are available |
| USDT Arbitrum | `satora-direct` | Enable after live quote and validation |
| USDC Arbitrum | `satora-direct` | Enable after live quote and validation |
| USDC Ethereum | `satora-direct` | Enable with minimum and fee disclosure |
| USDC Base | `satora-cctp` | Enable only when live quote and status tracking succeed |
| BTC Lightning | `nimiq-lightning` | Enable when the native route is supported and exercised |

Do not hard-code token contract values or wallet addresses into this document. Production route configuration must come from an approved, environment-specific registry and must be reviewed before use.

# 12. Backend data model

| Table | Key fields | Notes |
|---|---|---|
| `users` | `id`, `nimiq_address`, `created_at` | Identity anchor; no password required |
| `sessions` | `id`, `user_id`, `expires_at` | HttpOnly session after signed wallet challenge |
| `recipients` | `id`, `owner_user_id`, `display_name`, `archived_at` | Beneficiary container |
| `recipient_destinations` | `recipient_id`, `asset`, `network`, `address`, `is_default`, `verification_id` | Preference changes without deleting history |
| `recipient_verifications` | `address`, `network`, `challenge`, `signature`, `verified_at` | Optional proof of destination control |
| `payment_requests` | identity fields, asset, network, destination, amount, memo, expiry | Shareable request link/QR |
| `transfers` | user, recipient/request, target asset/network/destination/amount, public status | Metadata only; never private swap secrets |
| `transfer_proofs` | transfer ID, Nimiq hash, Lightning hash, Satora ID, EVM transaction hash | Public/non-secret proof identifiers where safe |
| `route_observations` | route ID, minimum, maximum, fee fields, observed timestamp | Availability diagnostics, not a pricing promise |

## 12.1 Client-only state

The following must remain in SDK-supported local persistence or another explicitly approved client-side mechanism, never in PostgreSQL or backend logs:

- Satora wallet mnemonic or secret material.
- Preimages.
- Recovery-critical private state.
- Any provider secret that could move funds.

The document contains no secret values. Any encountered operational value must be replaced with `[REDACTED]`.

# 13. Security and payment-safety invariants

- No backend custody and no backend private key capable of moving user funds.
- No mainnet payment without native Nimiq Pay approval.
- Persist before handoff.
- A BOLT11 invoice is single-handoff; duplicate payment actions are disabled.
- Address and network are validated against the selected route.
- Provider status alone is not enough to mark delivery when destination proof is expected.
- Unknown outcome locks the transfer into reconciliation.
- Quote age and validity guards prevent stale quote reuse.
- Logs never print mnemonics, preimages, private keys or recovery secrets.
- Receipts show safe proof IDs, not secrets.
- The UI distinguishes estimated destination value from owned balance.
- A manual recipient is not labelled verified.

# 14. Build plan and milestones

| Milestone | Target scope | Exit gate |
|---|---|---|
| P0 — Fresh foundation | New Thence repo, official Nimiq docs, app shell, design tokens, environments, test harness | Clean deploy and Nimiq Pay environment detection |
| P1 — Account + bank shell | Home, real NIM balance, bottom navigation, route registry, indicative selector | Real balance; selector never misrepresents ownership |
| P2 — Recipients + Requests | Beneficiary CRUD, preferred settlement, request links/QR, optional verification structure | Valid recipient and request can be created/opened/saved |
| P3 — Quote engine | Live quotes, minimums, maximums, fees, exact-receive solver, route availability, review screen | USDT Polygon exact-receive quote reliably passes |
| P4 — Transfer orchestration | Swap creation, persistence, Lightning handoff, settlement observation, claim/finalization | No duplicate handoff and safe unknown-state handling |
| P5 — Activity + Recovery + Receipts | Reload resume, reconciliation, bank statuses, proof receipt, Share Receipt | Pending transfer survives forced reload and resumes |
| P6 — Multi-route enablement | Arbitrum, Ethereum, Base/CCTP, native Lightning, route-specific warnings | Every enabled route passes live quote and validation tests |
| P7 — Mainnet proof | Small real NIM-to-stablecoin settlement and second route if possible | Destination value visibly arrives and proof receipt is complete |
| P8 — Submission/demo | README, public proof, demo script/video, final QA and competition PR | Judge flow works with no unsupported claims |

## 14.1 Implementation slices

Use small vertical slices rather than asking one agent or engineer to build the whole financial product at once.

1. Shell and live NIM account.
2. Recipient book.
3. Request link.
4. Quote-only Send.
5. Swap creation and recovery.
6. Nimiq handoff.
7. Settlement and claim.
8. Receipt and Activity.
9. Additional routes one at a time.
10. Mainnet proof and demo hardening.

# 15. Testing and verification strategy

| Layer | Tests |
|---|---|
| Domain | Route validation, asset/network safety, amount units, exact-receive solver, legal state transitions |
| Provider adapters | Nimiq capability normalization, user cancel, timeout, malformed invoice, Satora quote/create/status errors |
| Recovery | Reload after swap creation, reload after handoff, duplicate click, stale local state, unknown provider outcome |
| Recipients/requests | Address validation, network mismatch, archived destination, expired request, verification signature |
| UI | Recipient amount remains stable, unsupported route cannot continue, estimates are labelled |
| E2E | One testnet Nimiq wallet flow, one unpaid swap/reload flow, one real mainnet settlement when funds are available |

## 15.1 Failure cases that must be safe

- User closes the app immediately after approval.
- Satora times out after invoice payment.
- Quote expires before approval.
- Base bridge leg is delayed.
- User taps Pay twice.
- A syntactically valid destination is used with the wrong network.
- The provider returns an unknown outcome after funding.
- The user reloads during a claim or finalization step.

# 16. UX acceptance criteria

## 16.1 Home balance card

- Primary number is always the real NIM balance.
- Fiat equivalent is secondary and labelled approximate.
- The control says **Send value as**, not **Swap to**.
- Options are asset/network pairs, not bare chains.
- Estimated destination value is labelled **Est.** and never shown as owned balance.
- Temporarily unavailable routes cannot continue.
- Final NIM debit language says it will be shown by Nimiq Pay before approval.

## 16.2 Send flow

1. User starts from recent recipient, Recipients, request link or New recipient.
2. Destination preference supplies the default asset/network.
3. User enters the amount the recipient should receive.
4. Thence rejects amounts below live minimum or above live maximum.
5. Review shows recipient, amount, asset, network, shortened destination label, route fee information and quote freshness.
6. CTA is **Pay with NIM**.
7. Native Nimiq Pay approval remains visible; Thence does not mimic or replace it.
8. After handoff, the user cannot restart the same transfer while the outcome is unresolved.
9. Delivered is backed by final provider/destination evidence.

# 17. Backend API surface

```text
POST /api/session/challenge
POST /api/session/verify
GET  /api/me
GET  /api/recipients
POST /api/recipients
PATCH /api/recipients/:id
POST /api/recipients/:id/destinations
POST /api/recipients/verify-challenge
POST /api/recipients/verify
POST /api/requests
GET  /api/requests/:publicId
POST /api/requests/:publicId/mark-opened
POST /api/transfers                  # metadata shell only
PATCH /api/transfers/:id/status      # session-auth metadata updates
POST /api/transfers/:id/proofs       # non-secret proof identifiers
GET  /api/transfers
GET  /api/transfers/:id
GET  /api/routes/public              # enabled route metadata / health cache
```

Satora money-path calls remain direct from the client whenever the SDK/security model expects client-held recovery state. The backend may cache non-sensitive route observations but must not become a proxy that centralises custody or secrets.

# 18. Observability

## 18.1 Safe metadata

- Transfer ID.
- Public status.
- Asset and network.
- Requested amount.
- Satora swap ID where safe.
- Public transaction hashes where safe.
- Timings.
- Route availability.
- Sanitised error codes.

## 18.2 Never backend-log

- Wallet mnemonic.
- Private key.
- Swap preimage or secret.
- Full sensitive recovery object.
- Seed phrase.
- Raw auth signatures after verification when not needed.

## 18.3 Product analytics

Measure:

- Quote success rate.
- Payment-start rate.
- Delivery rate.
- Median settlement time.
- Repeat-recipient use.
- Request-link conversion.
- Route-specific failure classes.
- Recovery completion rate.

Do not optimise vanity volume before payment correctness.

# 19. Demo and submission checklist

Before submission, verify each item in the current implementation:

- Official Nimiq Mini App runs inside Nimiq Pay.
- Real NIM balance is visible.
- A recipient can be saved with a destination preference.
- A live quote shows applicable fees and minimums.
- Native Nimiq Pay approval is shown on camera.
- Destination balance or proof is shown before and after only when real evidence exists.
- Receipt contains safe proof identifiers.
- Activity survives reload.
- README distinguishes proven mainnet routes from quote-only routes.
- Submission is placed in Pay and explains why the recipient does not need NIM.
- No claim of custody, guaranteed fixed exchange rate or unsupported route.
- No credentials, private keys, wallet addresses or other secrets appear in the repository.

## 19.1 Ninety-second core story

- **0–15s:** “Daniel wants USDT on Polygon. I only have NIM.”
- **15–30s:** Open Daniel, enter the recipient amount and validate the route.
- **30–45s:** Show native Nimiq Pay approval and pay from NIM.
- **45–65s:** Show bank-style progress and safe unresolved-state handling.
- **65–80s:** Show the destination evidence if the settlement is real.
- **80–90s:** Show the receipt: NIM in, recipient asset out. “He never needed NIM.”

# 20. Decision gates

| Gate | Continue if | Stop or change if |
|---|---|---|
| USDT Polygon | Live quote and swap creation remain reliable | Provider route is unavailable or minimum makes the demo impractical |
| Exact receive | Solver satisfies target within documented tolerance | Pricing makes exact output misleading |
| Nimiq handoff | Native approval offers NIM and returns usable identifiers | Cancel and unknown outcomes cannot be distinguished safely |
| Recovery | Forced reload resumes without another payment | Recovery depends on secrets that cannot be durably preserved |
| Base/CCTP | Route is quoteable and status can be tracked to finality | Bridge leg is too opaque for a trustworthy receipt |
| Mainnet proof | Recipient receives expected asset and proof is capturable | Composed route fails without safe recovery |
| Submission | Demo works with accurate status labels and public evidence | A mock is required to support a live claim |

# 21. Current evidence and truth boundary

The supplied spike reports:

- 535 tests passed, with TypeScript, ESLint, Vite build and diff checks clean.
- `@nimiq/mini-app-sdk` version 0.2.4 exposed `payLightningInvoice({ invoice })` in the spike environment.
- `@satora/swap` version 1.7.1 produced live read-only quotes in the spike.
- USDT Polygon, USDT Arbitrum, USDC Ethereum and USDC Arbitrum quoted successfully in that spike.
- The Base quote succeeded with an explicit CCTP bridge fee.
- The current API/SDK shape accepted an arbitrary target destination in the spike.
- State machine, BOLT11 validation and duplicate-payment protections had test coverage.

The source also states that the no-money click test for unpaid swap creation and reload resume remained pending, and that one real mainnet NIM-to-stablecoin settlement remained pending.

These are **source-reported evidence claims**, not independently re-run results from this document package. Before public submission, rerun the tests and recapture the evidence in the current Thence repository.

# 22. Final blueprint

Build the bank. Hide the bridge.

The winning Thence version is not the one with the most chains. It is the one where a judge can understand the payment in five seconds and trust what happens when the happy path breaks.

## Visible product

- NIM balance.
- Recipients.
- Exact receive.
- Request to Pay.
- Activity.
- Receipts.

## Invisible machinery

- Lightning funding.
- Satora quoting and swaps.
- CCTP where required.
- Recovery vault.
- Idempotency.
- Reconciliation.

> **Pay from NIM. They receive what they use.**

## Sources

- Supplied source PDF: `/home/endy/.hermes/profiles/davinci/cache/documents/doc_d1e7b1e73459_NIM_Cross_Asset_Payments_Product_Idea.pdf`
- Supplied source PDF: `/home/endy/.hermes/profiles/davinci/cache/documents/doc_834b644d283e_NIM_Cross_Asset_Payments_PRD_Build_Plan_Architecture.pdf`
- Nimiq Mini Apps Competition — Cycle III: https://miniappscompetition.com/cycle3
- Nimiq Mini Apps Competition — official rules: https://miniappscompetition.com/rules
- Nimiq Developer Center — Mini Apps: https://nimiq.dev/mini-apps
