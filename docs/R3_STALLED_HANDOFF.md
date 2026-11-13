# R3 — stalled Lightning handoff detection and payment-risk disclosure

Incident `6f44918d` (2026-11-13). Nimiq Pay locked 7,244.09383 NIM in an HTLC and returned a hash. Thence verified the NIM source on-chain within 37 s. The provider (Satora) then stayed `pending` for an hour and expired; it never received the Lightning payment.

A read-only production comparison against genuine delivered Polygon payments found no measurable difference in route, invoice terms (5400 s expiry, CLTV 60, one route hint, same payee node), Nimiq Pay's HTLC counterparty, the HTLC shape or its ~59 h timeout. The only difference was the outcome. Successful NIM locks reached the provider in 23–34 s. **The upstream reason is unknown.** Thence cannot see Nimiq Pay's Lightning routing, so this change detects a stall early and explains it honestly. It does not prevent one.

## What changes

| Piece | Where | Behaviour |
|---|---|---|
| Derived stall condition | `src/lib/handoff-stall.ts` (`assessHandoffStall`) | Pure. **Stalled** only if the transfer is `LIGHTNING_HANDOFF`, the NIM source is independently `VERIFIED`, the latest provider read is a successful `pending` observation taken ≥ 5 min after the anchor and ≤ 5 min old, and nothing since the anchor reported another status. The anchor is the server's first `LIGHTNING_HANDOFF` timestamp when it is not after verification; otherwise it is the verification time. Provider errors, identity mismatches, stale reads, `expired` and funded statuses are never a stall. |
| Exposure to clients | `buildSummary` → `handoffStall` on every reconciliation summary | Display only. **No new transfer state**, no transition, no write. |
| Operator alert | `emitHandoffStallAlert`, called by `reconcileCore` after commit (owner and cron paths) | One `thence-alert {"alert":"LIGHTNING_HANDOFF_STALLED",…}` line in the web journal (same convention as `thence-chain-scan`). It carries the transfer id, an 8-character swap prefix and timestamps only. There are no wallet addresses, hashes or preimages. |
| Alert dedupe | `alertDue` + in-process guard | `alertDue` is true only when the latest observation **is** the first pending read past the threshold. Later cycles record newer reads, so a restart cannot re-alert. An in-process set also suppresses repeats within the 60 s observation-dedupe window. The cron run summary (`job_leases.last_summary`) counts `stalledHandoffs`. |
| Owner copy | `payment-progress.ts` (#72 framework) | The server stall verdict replaces #72's 2-minute "delayed" copy with **"Payment stalled — the Lightning payment hasn't arrived"**. Invoice-expired and passed-deadline copy still win. The copy never claims a refund. |
| Pre-approval disclosure | `ReviewStep` in `SendFlow.tsx`, copy in `src/ui/lib/handoff-risk.ts` | "If the Lightning payment fails, your NIM can stay locked … until the swap's refund timeout — about 2½ days (an estimate from recent payments). Nimiq Pay sets the exact timeout …". The duration is labelled as an estimate: Nimiq Pay sets the HTLC timeout, and Thence only learns the exact value after the lock. |

## Unchanged

Payment authorization rules, amounts and provider-defined route limits. There is **no new cap**. Also unchanged:
- the one-unresolved-payment rule and exposure derivation;
- source verification and claim deadlines;
- P4 and R2 closes and the state machine.

There is no automatic shutdown, and nothing is ever signed, claimed, refunded or released.

## Emergency switch (existing, unchanged)

`npx tsx scripts/pilot-switch.ts disable --production --yes --note "<reason>"` sets `pilot_controls.enabled = false`. That refuses **new** funding (create, prepare, authorize: `PILOT_DISABLED`). Reconcile, resume, attempt status, Finish delivery, settlement verification and the P4 and R2 owner closes never read this switch, so in-flight and stalled payments keep being tracked and recovered. Re-enable with `enable … --yes`. Flipping the switch is an operator decision. R3 never flips it.

## Tests

- `tests/r3-handoff-stall.test.ts` (pure) covers:
  - funding within 60 s;
  - a stall after 5 min;
  - the anchor rule;
  - too-early, stale and missing reads;
  - provider errors and mismatches;
  - expired and funded statuses;
  - the incident shape;
  - single alert emission;
  - stalled copy precedence;
  - Polygon funded and delivered views unchanged;
  - the disclosure wording.
- `tests/r1-auto-proof-publication.test.ts` (live test database, real `reconcileCore` and routes) walks one transfer through each stage:
  1. Verified and pending: not stalled.
  2. Aged pending read: stale, not stalled.
  3. Fresh read past 5 min: stalled, with exactly one alert and no state change.
  4. Owner reconcile: no re-alert.
  5. Simulated restart: no re-alert.
  6. Provider error: not a stall.
  7. No terminal row and no refund at any point.
  8. Late Lightning arrival: `SERVER_FUNDED`, with the stall cleared and history consistent.
