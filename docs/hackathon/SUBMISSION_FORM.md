# Submission form draft (NOT SUBMITTED)

The submission form on miniappscompetition.com couldn't be read before signing in (it is a
JavaScript page). The fields below come from the official rules and FAQ. Match them to the real
form when the owner opens it.

**Never fill the placeholders in this file.** This repository will become public. Personal
details and the payout address go **only** into the competition form, entered by the owner.

## Team lead (required by the rules)

| Field | Value |
|---|---|
| Name or pseudonym | `[OWNER: name or pseudonym]` |
| GitHub profile link | `[OWNER: GitHub profile URL]` |
| Nimiq wallet address for the prize payout | `[OWNER: NQ… payout address. Enter it in the form only]` |
| Team members (up to 5, optional) | `[OWNER]` |
| Country of residence (winners must prove an eligible country) | `[OWNER: for the form only, if asked]` |

## Project

| Field | Value |
|---|---|
| Mini App name | Thence |
| Category | **Pay** |
| Tagline | Pay in NIM. They receive USDC. |
| Live URL (opens in Nimiq Pay) | `https://paywiththence.cv` (served from the Hermes VPS since 2026-11-06) |
| GitHub repository (must be public, MIT) | `https://github.com/kaelah971/thence`. **Private today.** Make it public only with owner approval after the cutover |
| License | MIT |
| Demo video | `[OWNER: unlisted video link after the final-cut approval]` |
| Description (≤ 250 words) | Paste from [`SUBMISSION.md`](SUBMISSION.md) § "Project description". Update its last sentence to the true payment status on the day of submission |
| How it uses Nimiq Pay | SDK `init`, `listAccounts`, `sign` (wallet sign-in), `getBalance`, `payLightningInvoice` (pays with NIM). See the README § "Nimiq Pay integration" |
| Supports NIM / USDT | NIM: the sender pays in NIM. The recipient receives USDC on Polygon |

## Status sentence to use

**Use "Payments live".** Public payments have been live since 2026-11-06.

- **Payments live:** "Payments are live: judges can send a real NIM → USDC payment on Polygon
  from Nimiq Pay." Use this only after the owner's final payment verification on the VPS.
- **Payments not yet live:** "Public payments are implemented and tested, and are switched off
  in production while we finish our hosting migration. A real mainnet payment was delivered and
  verified on 2026-11-05."

## Gate before pressing submit (owner)

- [x] VPS cutover done (2026-11-06). The live URL works inside Nimiq Pay (iOS verified by the owner; Android: check once).
- [x] Payments live for judging (public mode, 2026-11-06; real public payment delivered).
- [ ] Repository made public, with explicit owner approval. Pre-public checklist done
      (`docs/PUBLIC_RELEASE_AUDIT.md`).
- [ ] Demo final cut approved, and the video link works when signed out.
- [ ] Legal drafts: the owner decides whether to publish them.
- [ ] Placeholders filled **in the form only**. Nothing personal committed to the repository.
- [ ] Deadline: **Wed Nov 11, 2026**. No time or timezone is published, so submit by Nov 10.
