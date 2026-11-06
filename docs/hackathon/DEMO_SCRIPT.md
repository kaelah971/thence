# Demo video: script, recording plan and shot list

The target length is **2:30–3:00**. The video is optional but encouraged by the rules; there is
no published length limit. Every claim maps to [`EVIDENCE.md`](EVIDENCE.md).

## Recording plan

| Item | Plan |
|---|---|
| Device | Phone with Nimiq Pay (Android preferred: no iOS cookie-loss risk mid-take) |
| Capture | Native screen recording at 1080×2340 or similar, portrait; no notifications (Do Not Disturb) |
| Desktop | 1920×1080 browser capture for Polygonscan and the code segments |
| Audio | Voiceover recorded separately (quiet room, USB or phone mic), then synced in editing |
| Edit | Phone footage centred on a dark 16:9 canvas; captions burned in; numbers on screen as lower-thirds |
| Privacy | Blur the full wallet addresses, the NIM balance (if wanted) and any personal names. Use a demo recipient named "Ana (demo)" |
| Money | **No new payment is required.** Segment 4 uses the verified 2026-11-05 payment (screenshots and chain). If the owner approves a new supervised payment, record it under the pilot runbook; nothing in this plan enables payments |
| Hosting | YouTube (unlisted or public) or Loom; link it in the submission form and README |

## Script and shot list

| # | Time | Shot | Voiceover (VO) | On-screen text |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Phone: Nimiq Pay home → open Thence from the Mini Apps list | "Your friend wants dollars on Polygon. You have NIM. Thence is a Nimiq Pay Mini App that turns one into the other, and you say what *they* receive." | **Thence** · Pay in NIM. They receive USDC. |
| 2 | 0:15–0:35 | Thence sign-in: wallet signature prompt in Nimiq Pay → Home with the NIM balance | "No sign-up. You sign in with your Nimiq wallet: Thence asks Nimiq Pay to sign a one-time challenge. Your NIM balance comes straight from the wallet." | Wallet sign-in · Nimiq Pay SDK |
| 3 | 0:35–1:05 | Recipients → add "Ana (demo)", paste a Polygon wallet → Send → type **25.00** USDC → live quote with expiry | "Pick who and type what they should receive: 25 USDC, exactly. Thence gets a live quote and shows the Lightning amount needed, with fees included. The quote has a timer. Thence never guesses a NIM rate; Nimiq Pay shows the exact NIM before you confirm." | Recipient-first · exact amount · live quote |
| 4 | 1:05–1:45 | **Real payment evidence** (still frames from the 2026-11-05 screenshots, or a re-enactment *labelled* as such): swipe to approve → Nimiq Pay confirm (≈985 NIM) → "Finish delivery" → Delivered | "Here's a real mainnet payment from November 5th. One swipe, one confirmation in Nimiq Pay. The NIM pays a Lightning invoice, Satora's atomic swap locks USDC on Polygon, and Finish delivery releases it to the recipient." | Mainnet · 2026-11-05 · 0.30 USDC delivered |
| 5 | 1:45–2:10 | Desktop: Polygonscan for block 96777101 → USDC transfer of 0.300394 (address blurred) → Thence receipt "256 confirmations" | "Thence only says *Delivered* after it has verified the token transfer on-chain and waited for 256 Polygon confirmations. The receipt links the proof." | Verified on-chain · 256 confirmations |
| 6 | 2:10–2:30 | Phone: Requests → create a 10 USDC request → share link → open `/r/…` showing the locked amount | "It works in reverse too. Create a payment request, share the link, and the payer lands on a locked, prefilled review." | Payment requests |
| 7 | 2:30–2:50 | Desktop: the README state diagram → `docs/ARCHITECTURE.md` → CI green | "Under the hood: a Next.js app, a Postgres state machine where every transition is audited, a reconciler that verifies and never pays, and swap secrets that never leave your phone. If anything fails before delivery, the swap refunds automatically." | Non-custodial · audited · refund-safe |
| 8 | 2:50–3:00 | Logo / end card | "Thence. Pay from what you have. They receive what they use." | paywiththence.cv · github.com/kaelah971/thence |

### Mandatory honesty line (say or caption during segment 4 or 7)

> "Public payments are built and tested but switched off in production while we finish our
> hosting migration. The payment you just saw was a supervised mainnet run."

If the owner enables public payments before recording, replace this with the then-current
status, and only after the payment has been verified.

## Screenshot checklist (capture on device, production or pilot)

| File (suggested) | Screen | Status |
|---|---|---|
| `shot-01-welcome.png` | Welcome / onboarding | To capture |
| `shot-02-home-balance.png` | Home with NIM balance (blur if wanted) | To capture |
| `shot-03-recipient.png` | Recipient with Polygon wallet + verified badge | To capture |
| `shot-04-send-quote.png` | Send review: 25.00 USDC, sats needed, quote timer | To capture |
| `shot-05-request-link.png` | Payment request share sheet and `/r/:id` page | To capture |
| `shot-06-delivered-receipt.png` | Delivered receipt for `2c2432af` (Activity) | To capture (from the existing account) |
| `shot-07-polygonscan.png` | Block 96777101 USDC transfer (address blurred) | To capture |
| simulated set | Approve → funding → Finish delivery → finality → Delivered | **Available**: `docs/pr-assets/ux-mobile-payment-progress/390-*.jpg` (label "simulated") |

Store final assets in `docs/hackathon/assets/`, after checking every frame for addresses, names
and balances.
