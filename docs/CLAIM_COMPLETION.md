# P3 — Reliable payment completion (claim orchestration)

Prepared 2026-11-04. Scope: the step between "Satora funded the Polygon HTLC"
and "USDC verified in the recipient's wallet" — the step that failed on
2026-11-02 (077770a1: funded 21:13Z, observed funded 21:30Z, claim deadline
22:12:42Z, never claimed, provider refund 22:16:54Z).

## What the owner must do

**One tap: "Finish delivery"**, in the same browser that started the payment,
before the deadline shown next to it. That button appears on the Send screen
*and* in Activity as soon as the server sees the funding (the shared P1
tracker), with the Polygon deadline and time left (P2). Nothing else.

Everything after the tap is automatic and verified: server re-check → SDK
claim → claim outcome checked → on-chain USDC proof → `DELIVERED` + receipt.
If the app is closed right after the tap, the server reconciler finishes the
verification on its own (P6 + `verifySettlementCore`).

## The path, end to end

1. **Funding observed** (P1 tracker / P6 cron) → `SERVER_FUNDED`, label
   "Action needed — finish delivery", pill "Finish delivery needed" (Nov 2:
   "Sending" / "On its way" told the owner nothing was needed).
2. **Send and Activity show the action.** Activity now runs the tracker for
   every in-flight payment, so funding that lands while the detail is open
   surfaces the button there (Nov 2: the action only mounted if the row was
   already funded when opened).
3. **Owner taps Finish delivery.** The browser checks, in order: claim flag,
   session, recovery binding (owner, transfer, swap, route, destination,
   amount), SDK readback (recovery material present, payment hash, deadline =
   the server's deadline), client-clock window > 5 min, no unresolved earlier
   attempt.
4. **Server authorization** `POST /api/transfers/:id/claim-intent`
   (`src/lib/claim-intent.ts`), gather-first / commit-under-lock:
   - fresh Satora read: same swap, direction, hash lock, amount, destination,
     chain/token, deadline; still `serverfunded`; no claim or refund tx;
   - **on-chain contract state** (`verifyHtlcFunding`): the provider's fund tx
     is mined, successful, reorg-consistent, ≥ 32 confirmations, and contains
     the pinned HTLC's fund event with topic[1] = this hash lock and timelock
     (data word 2) = the bound deadline — checked against the real Nov 2 fund
     receipt;
   - five-minute unsafe window (server clock);
   - per-transfer **claim lease** (`job_leases`, 10 min — also the pending
     horizon for retries, see below): a second tab, device
     or double tap is refused `CLAIM_IN_PROGRESS`;
   - `SERVER_FUNDED → CLAIMING`, audited `CLAIM_AUTHORIZED` (same transaction).
   The browser then cross-checks the server's answer (swap id, hash, deadline,
   destination, amount) against its own recovery material before the claim.
5. **SDK claim** (`claimStoredSwap`, unchanged: gasless coordinator, preimage
   stays in the SDK's IndexedDB and is revealed only by the SDK).
6. **Outcome checked, never trusted.** Success → "Delivery submitted —
   confirming it arrived", no second button (also after reload). Unknown
   outcome → no blind retry; one verification round runs after 20 s. A retry
   is authorized by the server only when ALL hold (P7): the 10-minute
   pending horizon since the last authorization has passed (an unspent HTLC
   does not prove a relayed claim is not still in the mempool); Satora shows
   the swap `serverfunded` with no claim tx; the pinned HTLC's own log shows
   only the funding event for this lock (`verifyHtlcUnspent`); and the
   deadline is still outside the five-minute unsafe window. Defence in depth:
   the HTLC can be redeemed once, so a duplicate claim can only revert, never
   deliver twice.
7. **Delivery verified independently.** The tracker calls `verify-settlement`
   while the provider reports claim activity; the server cron does the same
   with the browser closed. `DELIVERED` is written only with the ERC20
   Transfer proof (canonical token, recipient, ≥ exact amount, reorg check,
   finality) and its audit row; the receipt renders only for `DELIVERED`.

Never treated as delivery: Nimiq Pay approval, the Lightning payment,
Satora's funding, a successful SDK claim response, or provider
`clientredeemed`/`serverredeemed`.

## Decision: one approval at setup vs. a separate Finish delivery

**Implemented: the explicit Finish delivery tap.** Not implemented, pending
your separate approval: claiming without that tap.

Analysis:

- *What a claim reveals.* The SDK's gasless claim sends the preimage to
  Satora's coordinator, which redeems the HTLC to the recipient. Once the
  pinned HTLC is verifiably funded for this hash lock with the right deadline,
  revealing the preimage is what the protocol is designed for: it can only
  release the USDC lock to the bound destination. The P3 checks (identity,
  on-chain fund event, deadline, unsafe window, lease) are exactly the
  preconditions an automatic claim would need, so a **consent-at-setup,
  auto-claim-while-the-app-is-open** variant is technically justifiable on
  top of this work: the same `attemptClaim` path, triggered by the tracker
  instead of a tap, with the consent recorded at Nimiq Pay approval.
- *What it would not fix.* The preimage lives only in this browser. An
  automatic claim still needs this page open and in the foreground between
  funding and the deadline (Nimiq Pay's webview is backgrounded or closed
  often). It would remove the tap, not the dependency on the browser.
- *Unattended (browser-closed) claiming* requires the preimage — or a
  pre-signed claim — on a server. That is a custody change: Thence would hold
  material that, combined with a held Lightning payment, controls the money.
  It needs its own design, threat model and your approval; it is not built.
- *Residual risks of auto-claim even while open:* a stale or compromised
  page claiming without the owner present; harder for the owner to
  understand why a payment "finished itself"; less explicit consent at the
  moment value is released.

Remaining limitation of the explicit design: **if the owner does not tap
Finish delivery before the deadline (minus 5 minutes) in the browser that
holds the recovery material, the provider refunds its Polygon lock** and the
payment ends `REFUNDED` (Polygon side only; Nimiq Pay returns the NIM on its
own timer). The deadline is ~1 h from swap creation; on Nov 2 the funding was
visible 42 minutes before it.

## Not changed

- No preimage handling, storage or transport outside the SDK.
- The pilot kill switch does not gate the claim path (stopping the pilot
  must never turn already-funded payments into refunds).
- `NEXT_PUBLIC_THENCE_ENABLE_CLAIM` stays a build-time switch; with it off the
  button explains the pause and nothing is authorized.
