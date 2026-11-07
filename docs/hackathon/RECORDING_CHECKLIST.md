# Final demo recording checklist

**Status:** updated 2026-11-07. **Payments are live** (public mode, Hermes VPS; Polygon
finalized-tag settlement). A real payment takes about 2 minutes, so it can be filmed in full. This checklist supersedes the shot list in [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md)
wherever they differ.

## Owner decisions this plan follows (2026-11-06, updated 2026-11-07)

- Production payments are **live** for any Nimiq Pay wallet. The owner films one real payment
  (Track B). No one pays on the owner's behalf.
- **No Polygonscan link or explorer page** appears publicly, and none appears in the video.
- The Privacy Policy and Terms remain unpublished drafts.
- The repository stays **private** until the owner approves otherwise after cutover.

## Two recording tracks

| Track | When | What it proves | Payment needed? |
|---|---|---|---|
| **A: product walkthrough** | Any time | Sign-in, Home, recipients, the live quote, payment requests, Activity, receipts | No |
| **B: live payment** | Any time (payments live) | One real approve → Nimiq Pay → one-tap Finish delivery → Delivered, filmed end to end (about 2 min) | Yes: about 0.30 USDC (about 1,000 NIM), paid by the owner |

The **final video = Track A + Track B segment 5**. Use segment 5-ALT (an existing Delivered
receipt) only if a live take fails. No pause caption is needed any more.

## Pre-flight (tick all before pressing record)

### Device

- [ ] Use an Android phone with Nimiq Pay up to date. Prefer Android: iOS may drop the session
      cookie on an app switch (`docs/RISK_IOS_WEBVIEW_STORAGE.md`).
- [ ] Do Not Disturb on. No other notifications. Battery above 60%. Brightness at maximum.
- [ ] System font size at default. The language is English.
- [ ] The screen recorder captures at native resolution, portrait, and **without** microphone
      (the voiceover is recorded separately).

### Accounts and data

- [ ] Sign in with the owner's Nimiq Pay account.
- [ ] Set the Thence display name to a **pseudonym**, not a legal name.
- [ ] Create a demo recipient called **"Ana (demo)"**, using a wallet the owner controls. Its
      address will be **blurred**.
- [ ] Activity contains the 2026-11-05 payment (`2c2432af…`), Delivered.
- [ ] Clear any half-finished or "Needs attention" payments from view, or don't open them on
      camera.

### Environment

- [ ] Open the production URL inside Nimiq Pay. After the cutover, confirm it is served from the
      VPS.
- [ ] `GET /api/health` returns ok. `GET /api/routes/public` lists `usdc-polygon` as available.
- [ ] Payments live: Review → Swipe reaches the Nimiq Pay approval (no "Payments temporarily
      unavailable").
- [ ] The paying wallet holds about 1,500 NIM or more (0.30 USDC costs about 1,000 NIM plus
      Lightning fees).

### Desktop

- [ ] Run the browser at 1920×1080, with an empty profile, no bookmarks bar and no other tabs.
- [ ] Have GitHub open at the README diagram and at the green CI run. The repository is private,
      so record while signed in and crop out the account avatar and name.

## Shot list: exact screens, actions and narration

Running time is about 2:45. On-screen captions are in *italics*.

### Segment 1 — Hook (0:00–0:12)

- **Screen:** Nimiq Pay home → the Mini Apps list → tap **Thence**.
- **Action:** a single tap. Hold 1 s on the Thence welcome screen.
- **Voiceover:** "Your friend wants dollars on Polygon. You have NIM. Thence is a Nimiq Pay Mini
  App: you choose what *they* receive, and you pay in NIM."
- **Caption:** *Thence · Pay in NIM. They receive USDC.*
- **Proof:** none needed (product framing).

### Segment 2 — Wallet sign-in (0:12–0:30)

- **Screen:** Welcome → **Continue with Nimiq Pay** → the Nimiq Pay signature prompt → approve →
  **What should we call you?** (if shown) → Home.
- **Action:** approve the signature. On Home, hold on **Balance**.
- **Voiceover:** "No sign-up and no password. Thence asks Nimiq Pay to sign a one-time challenge,
  and the server verifies the signature. Your NIM balance comes straight from the wallet."
- **Caption:** *Wallet sign-in · Nimiq Pay SDK*
- **Blur:** the NIM balance (optional) and the Nimiq address.
- **Proof:** `tests/auth.test.ts`; EVIDENCE row "Nimiq wallet sign-in".

### Segment 3 — Recipient and live quote (0:30–1:00)

- **Screen:** Recipients → **Add a person** → name "Ana (demo)" → paste a Polygon wallet → USDC ·
  Polygon → **Save this recipient**. Then **Send money** → Ana → type **25** → **Review payment**.
- **Action:** pause 2 s on the review. It should show **They receive** 25.00 USDC, **Lightning
  needed**, the quote timer and "Shown by Nimiq Pay before you approve".
- **Voiceover:** "Pick who, then type what they should receive: 25 USDC, exactly. Thence gets a
  live quote with fees included, priced in Lightning sats. Thence never guesses a NIM rate:
  Nimiq Pay shows the exact NIM before you approve."
- **Caption:** *Recipient-first · exact amount · live quote*
- **Blur:** the wallet address. Show only the first 4 and last 4 characters, or blur it fully.
- **Proof:** EVIDENCE row "Live exact-receive quote".

### Segment 4 — Payment request (1:00–1:15)

- **Screen:** Requests → **Request money** → 10 USDC → **Your request is ready** → **Copy link**
  → open the link → the request page with the locked amount.
- **Voiceover:** "It works in reverse too: create a payment request, share the link, and the payer
  lands on a locked, prefilled review."
- **Caption:** *Payment requests*
- **Blur:** the destination address on the request page.
- **Proof:** `tests/requests.test.ts`.

### Segment 5 (Track B) — The real payment, live (1:15–2:00)

Only record this when the owner has approved the supervised payment.

- **Screen:** the review → **Swipe to continue to approval** → **Approve in Nimiq Pay** → the
  Nimiq Pay confirm sheet (NIM amount visible) → back in Thence ("Waiting for confirmations.")
  → **Finish delivery** → **Delivered** with the receipt.
- **Action:** keep the app in the foreground the whole time. Don't switch apps.
  - **Tap Finish delivery once.** It shows "Securing the payment on Polygon (N of 32
    confirmations)" and continues by itself, after about 70 s.
  - **Delivered** follows within seconds, at Polygon finality.
  - Optionally cut the 70 s wait with a "≈ 1 minute later" card.
- **Voiceover:** "One swipe, one confirmation in Nimiq Pay. The NIM pays a Lightning invoice;
  Satora's atomic swap locks USDC on Polygon; one tap on Finish delivery releases it to Ana. Thence
  only says Delivered after it verifies the token transfer on-chain at Polygon finality — about
  two minutes from approval."
- **Caption:** *Real mainnet payment · verified on-chain*
- **Blur:** the recipient address, the full transaction hashes on the receipt, and the NIM
  balance.
- **Proof:** the receipt "Payment proof" (on-device). Keep the full transaction hash in operator
  records; **don't** show an explorer.

### Segment 5-ALT (Track A) — The verified 2026-11-05 payment (1:15–2:00)

- **Screen:** Activity → the 0.30 USDC payment → **Delivered** → **Receipt** / **Payment proof**.
- **Voiceover:** "Here's a real mainnet payment from November 5th: 0.30 USDC delivered on
  Polygon, paid with NIM from Nimiq Pay. Thence marked it Delivered only after verifying the
  transfer on-chain with 256 confirmations."
- **Caption:** *Mainnet · 2026-11-05 · 0.30 USDC delivered · 256 confirmations*
- (Fallback only. Payments are live, so no pause caption is needed.)
- **Blur:** the recipient address and all full hashes on the receipt.
- **Proof:** `docs/PILOT_2026-11-05_FIRST_DELIVERY.md` and `docs/hackathon/EVIDENCE.md`.

### Segment 6 — Under the hood (2:00–2:30)

- **Screen (desktop):** the README "How a payment works" diagram → `docs/ARCHITECTURE.md` state
  diagram → the green CI run (build, integration, e2e).
- **Voiceover:** "Under the hood: a Postgres state machine where every step is audited; swap
  secrets that never leave your phone; and a reconciler that verifies but never pays. If anything
  fails before delivery, the swap refunds and Nimiq Pay returns the NIM."
- **Caption:** *Non-custodial · audited · refund-safe · open source (MIT)*
- **Proof:** ARCHITECTURE.md and CI.

### Segment 7 — Close (2:30–2:45)

- **Screen:** the end card with the Thence logo, the production URL and the GitHub URL. **Add the
  GitHub URL only if the repository is public by then.**
- **Voiceover:** "Thence. Pay from what you have. They receive what they use."

## Never on screen

- Full wallet addresses (the owner's, or any recipient's), Nimiq addresses or full transaction
  hashes.
- Polygonscan, Tenderly or any block-explorer page.
- Vercel, Neon, Cloudflare or VPS dashboards, terminals, `.env` files, SSH sessions or any
  server hostname except the public app URL.
- Legal names, email addresses, phone numbers or the prize payout address.
- The words "live for everyone", "supports USDT", "instant", "zero fees" or "audited by…".

## Post-production checklist

- [ ] Step through every frame at 0.25× and confirm each blur holds, including in transitions and
      the keyboard.
- [ ] Captions are burned in. Numbers match the take (amount, about 2 minutes) and, for 5-ALT,
      EVIDENCE.md exactly.
- [ ] Segment 5 shows a real, current payment; 5-ALT is used only if a live take failed.
- [ ] The length is at most 3:00. Export at 1080p, H.264, with audio normalised to about -14
      LUFS.
- [ ] Upload as **Unlisted** (YouTube or Loom) until the owner approves the submission.
- [ ] The owner watches the final cut and approves it before the link goes anywhere.

## Stills for the submission (taken from the same session)

| File | Screen | Blur |
|---|---|---|
| `shot-01-welcome.png` | Welcome | — |
| `shot-02-home.png` | Home | Balance (optional), address |
| `shot-03-recipient.png` | Recipient "Ana (demo)", Preferred wallet | Address |
| `shot-04-review.png` | Review payment, 25.00 USDC | Address |
| `shot-05-request.png` | Your request is ready | Address |
| `shot-06-delivered.png` | Delivered receipt | Address, hashes |

Store them in `docs/hackathon/assets/` only after the blur check.
