# R8 — Payment recovery: one state, one action

Status: implemented on `feat/payment-recovery-ux`. No migration, no new
write paths, no new provider or chain calls.

## Problem

Activity's payment sheet had grown one control per incident: "Check for
updates" (server reconcile), "Check payment status" (provider read), the live
card's own "Check again", and close actions that appeared only after the owner
happened to press the right check. The close affordance was decided in the
browser from the provider's status alone; the server's gates were only applied
when the close was attempted. The result was a screen that could show several
status checks at once and a "close" that the server would then refuse.

## Design

### Five recovery kinds (`src/ui/lib/recovery-state.ts`)

Every payment opened in Activity is classified into exactly one kind, with one
primary action:

| Kind | When | Primary action |
| --- | --- | --- |
| `preparation` | `DRAFT`, `QUOTED`, `SWAP_CREATED`, `AWAITING_NIM_APPROVAL` | Resume (same payment); Cancel unpaid when the provider reports the swap expired before approval |
| `uncertain` | `LIGHTNING_HANDOFF` without a server-verified NIM source, `OUTCOME_UNKNOWN`, `RECONCILING`, `NEEDS_ATTENTION` | **Check payment status** (the only status check) |
| `funds-moved` | `CLIENT_FUNDED`, `SERVER_FUNDED`, `CLAIMING`, or `LIGHTNING_HANDOFF` with a server-verified NIM source | The live progress card (Finish delivery / verifying) |
| `expired-closable` | The server's close-gate preview passes | Close expired payment (P4) or Check whether my NIM was returned (R2) |
| `closed` | Terminal statuses | Receipt (delivered / delivered short) or nothing |

The classifier is pure and conservative. Missing client evidence, such as no
NIM hash, no provider read or an expired invoice alone, never moves a payment
into another kind. Provider-reported funding stays `uncertain` until the
server verifies it. A host failure is never read as "nothing moved". Wallet
not ready, Fastspot swap creation and outcome unknown all still normalize to
`unknown`, exactly as before.

### One status check

"Check payment status" runs the server reconcile and then a fresh provider
read in one control. It replaces "Check for updates" and the evidence panel's
own check. In Activity, the live card's "Check again" is suppressed when the
card is waiting on a check, so the sheet always has one. A failed provider
read clears the old evidence, so a stale read can never keep a close action
on screen. Rate-limit wording (`friendlyMessage`, 429) stays visible even when
the check surfaces a different action.

### Server-gated close preview (`src/lib/close-eligibility.ts`)

`GET /api/transfers/:id/provider-evidence` now returns:

```json
"closeEligibility": {
  "expiredUnfunded": { "eligible": true,  "reason": null, "message": null },
  "nimReturn":       { "eligible": false, "reason": "NIM_SOURCE_NOT_VERIFIED", "message": "…" }
}
```

It runs the same pure gates as the actions: `assessNonChainEvidence` for P4,
and `assessLocalForNimReturn` + `assessProviderEvidence` for R2. These run
against the fresh provider read and a read-only local-evidence query. The
preview is never a substitute for the actions. Both still re-read everything
and run their independent chain checks: the Polygon HTLC scan for P4 and the
Nimiq return proof for R2. The client shows a close only when the matching
gate is `eligible` **and** the read is for the payment's current status. Older
servers without the field are treated as not eligible. A refused close
overrides the preview until the next check, and its plain-language reason
appears once, in the recovery card.

## Unchanged

Source verification, reconciliation and its rate limits, claim gates and
replay protection, refund handling, R7 short-delivery proofs, the public
proof feed, and every server state transition.

## Regression coverage

- `tests/recovery-milestone.test.ts` (offline) covers wallet not ready,
  Fastspot swap creation (including a 504 text), unknown outcome, delayed
  source verification, rate-limit wording, a stalled handoff after NIM
  funding, expired-but-unverified, verified expired-unfunded, delivered short
  and normal delivery. It also checks the server gate preview against
  synthetic facts.
- `tests/ui-payment-lifecycle.test.tsx` covers Activity with one status
  check, a server-gated close, refusal handling, the R2 NIM-return path and a
  rate-limited check.
- `tests/p4-expiry-resolution.test.ts` (live test DB) checks that the
  provider-evidence preview matches what `close-expired` then does.
