# Nimiq Mini Apps Competition, Cycle III: submission pack

> **NOT SUBMITTED.** Prepared for owner review on 2026-11-06. Nothing gets submitted without the
> owner's approval.

## Official requirements (read 2026-11-06)

Sources: miniappscompetition.com `/rules`, `/cycle3`, `/scoring`, `/faq` and `/payout`.

| Requirement | Thence status |
|---|---|
| Deadline: **Wed Nov 11, 2026** (no time or timezone published; check the Registration Dashboard) | ⚠️ 5 days left. Submit by Nov 10 to be safe |
| Built on the Nimiq Pay Mini Apps Framework, integrated with Nimiq Pay, supports **NIM or USDT** | ✅ `@nimiq/mini-app-sdk`; pays with NIM |
| **Public GitHub repo under the MIT license** | ⚠️ MIT ✅, but the repo is **PRIVATE**. It must be public before submitting (owner decision, after the VPS migration) |
| No hard-coded private keys or secrets | ✅ History audited: [`../PUBLIC_RELEASE_AUDIT.md`](../PUBLIC_RELEASE_AUDIT.md) |
| Original code, or properly attributed | ✅ Dependencies under their own licenses (README) |
| "Fully functional and usable on the first try. No prototypes or mockups." | ✅ **Public payments are LIVE** (since 2026-11-06 21:23Z, served from the Hermes VPS). Any authenticated Nimiq Pay wallet can pay. The first public payment was delivered on 2026-11-06 |
| Written description, **max 250 words** | ✅ Below (word count checked) |
| Category | **Pay** |
| Team lead: name or pseudonym, GitHub link, **Nimiq wallet address for payout** | ⚠️ Owner to supply |
| Demo video | Optional, encouraged. Script in [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) |
| Method | Submit page: GitHub sign-in → form → opens a PR to the official competition repo. The form fields could not be read (JavaScript page); confirm them when submitting |
| Eligibility | 18+, a team of up to 5, not in an OFAC-sanctioned jurisdiction, one submission per cycle |

**Scoring (100 points):**

| Points | Criterion |
|---|---|
| 45 | Functionality, reliability and usefulness |
| 25 | Nimiq Pay and Nimiq integration (5 of these for using NIM "beyond simply accepting a payment") |
| 15 | Real usage |
| 10 | Design and UX |
| 5 | Builder promotion checklist |

**Prize for #1 Pay:** $4,000 USDC on Polygon, in 3 monthly instalments. Each instalment depends
on the app staying live and being maintained. Winners are expected to maintain the app for 12
months.

## Project description (≤ 250 words) — ready to paste

> **Thence: pay in NIM, they receive USDC.**
>
> Thence is a Nimiq Pay Mini App for paying people who don't use Nimiq. You type the amount the
> recipient should receive (for example 25.00 USDC), pick their wallet, and approve once in
> Nimiq Pay. Thence gets a live exact-receive quote. Nimiq Pay pays a Lightning invoice with your
> NIM, and a Satora atomic swap delivers USDC on Polygon straight to the recipient's wallet.
> There's no exchange account, no bridge, and no custody: swap secrets stay on your phone, and
> Thence never holds funds.
>
> Thence only says "Delivered" after it has verified the token transfer on-chain with 256
> Polygon confirmations, and it links the proof. If anything fails before delivery, the swap
> refunds and Nimiq Pay returns the NIM.
>
> Features: wallet sign-in through the Nimiq Pay SDK, saved recipients with verified wallets,
> recipient-first amounts, shareable payment-request links, an activity timeline with receipts,
> and server reconciliation with an audited state machine.
>
> It's for freelancers, families and small merchants who hold NIM but owe someone dollars.
>
> Live: payments are open to any Nimiq Pay wallet. Real NIM → USDC payments on Polygon
> mainnet have been delivered and verified on-chain, and a payment completes in about two
> minutes.
>
> Open source (MIT), Next.js and PostgreSQL, with integration and browser end-to-end tests in CI.

Fix the final status sentence on the day of submission: if public payments are on, say so.

## Technical explanation (for the README link or a longer form field)

1. **SDK:** `init()` provides the injected provider. `sign()` handles sign-in (Ed25519, verified
   server-side). `getBalance()` reads the NIM balance. `payLightningInvoice()` pays the
   byte-identical authorized invoice, exactly once.
2. **Route:** NIM → Lightning (Nimiq Pay) → Satora Lightning→EVM HTLC swap (in the browser) →
   USDC on Polygon. The claim happens on **Finish delivery**.
3. **Integrity:** amounts are bigint atomic units from end to end. The server re-verifies swap
   terms (amount, destination, token, chain) before authorizing the handoff. One authorization
   per transfer, and a claim lease.
4. **Proof:** the settlement verifier reads the ERC-20 `Transfer` log via viem, requires the
   amount to be ≥ target and waits for Polygon finality (the `finalized` block tag; the original
   rule was 256 confirmations, which is still the code default). The proof is stored on an
   immutable receipt.
5. **Recovery:** an on-device vault with readback; a server reconciler every 2 minutes that
   reads and verifies but never pays; refund detection; and a mode plus emergency switch that
   pause new payments without blocking recovery.
6. **Quality:** about 80 Vitest files (unit and live-handler integration on an isolated database)
   and Playwright E2E in WebKit and Chromium with a simulated host, provider and chain.

## Feature highlights (bullets for the form or socials)

- Recipient-first: say what they get, not what you spend.
- One Nimiq Pay approval: NIM in, USDC out on Polygon.
- Delivered = proven on-chain (Polygon finality), with a receipt.
- Non-custodial: secrets stay on the device.
- Payment requests with shareable links.
- Refund-safe by design; every state change audited.

## Likely questions from judges

| Question | Answer |
|---|---|
| Why Lightning? | Nimiq Pay can pay Lightning invoices natively, and Satora swaps Lightning into EVM stablecoins atomically. That gives a NIM → USDC path with no custodian. |
| What does the sender pay? | Nimiq Pay shows the NIM debit at confirmation. Thence shows the Lightning sats, with fees included, and does not invent a NIM rate. |
| What if I close the app mid-payment? | Before delivery, the swap refunds after its deadline. Recovery material stays on the device, and the reconciler tracks the outcome. |
| Mainnet? | Yes. One supervised mainnet delivery on 2026-11-05 (blocks 96777064 and 96777101). |
| How long does a payment take? | About 2 minutes from approval in Nimiq Pay: about 70 s until **Finish delivery** completes (one tap; it waits for 32 Polygon confirmations of the provider's funding), then **Delivered** seconds after the claim reaches Polygon finality. |
| Can payments be stopped? | Yes. A database emergency switch pauses new payments instantly without a redeploy; recovery, claims and refunds keep working. |

## Submission checklist

- [ ] VPS migration complete and production healthy (owner)
- [ ] **Owner approves making the repo public** → Settings → visibility → Public
- [ ] Owner decides on the payment mode for judging (see "Decisions")
- [ ] Demo video recorded, uploaded and linked
- [ ] Screenshots captured and checked for addresses and names
- [ ] Legal drafts reviewed, and published at a URL, or left as drafts (owner)
- [ ] Team lead name or pseudonym, GitHub link and **Nimiq payout address** ready
- [ ] Live URL works inside Nimiq Pay on Android and iOS
- [ ] Final description sentence updated to the true payment status
- [ ] Owner submits through the Submit page (opens the PR to the competition repo)
- [ ] Builder promotion checklist items done (5 pts; see `/scoring`)

## Owner decisions (recorded 2026-11-06)

1. **Repo visibility:** stays **PRIVATE**. The owner decides after the VPS cutover. (It must be
   public to be eligible.)
2. **Payments for judging:** **LIVE** in public mode since 2026-11-06 21:23Z, after the VPS
   migration (see `docs/PAYMENT_ACTIVATION_VPS.md`). Polygon finalized-tag settlement has been
   active since 2026-11-07 08:39Z (`docs/POLYGON_FINALITY.md`).
3. **Polygonscan link:** **not published.** The verified evidence is kept for the demo, with
   wallet details masked.
4. **Legal:** the Privacy Policy and Terms stay **drafts** for owner review, unpublished.
5. **Form:** prepared with placeholders in [`SUBMISSION_FORM.md`](SUBMISSION_FORM.md).
   Personal details and the payout address go into the form only.
6. **Recording:** follow [`RECORDING_CHECKLIST.md`](RECORDING_CHECKLIST.md).

Still open: making the repository public (owner, after the pre-public checklist), the demo
video, and submitting the form.
