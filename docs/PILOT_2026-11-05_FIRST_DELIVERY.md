# First supervised mainnet payment — 2026-11-05 (2c2432af) — DELIVERED

A read-only postmortem. Nothing was done to produce it: no funds moved, no claim was replayed,
no handoff was repeated and no setting was changed.

**Privacy (updated 2026-11-07 for the public release):** wallet addresses, transaction hashes,
block numbers, exact on-chain amounts and absolute timestamps are deliberately omitted. Any of
them would let an explorer identify the owner's wallet. Times are shown relative to the quote
(**T**). The full evidence is kept in operator records.

## Outcome

**Delivered and independently verified.** 0.30 native USDC on Polygon reached the owner's
wallet with one approval, one claim and one transfer.

| Fact | Value |
|---|---|
| Transfer | `2c2432af…`, route `usdc-polygon`, target `300000` atomic (0.30 USDC) |
| Swap | Lightning → Polygon, 380 sats; Polygon claim deadline about T+60 min |
| NIM debit (owner, Nimiq Pay screen) | about 1,000 NIM, under the 1,900 NIM pilot ceiling |
| Funding tx (provider HTLC) | mined at T+41 s, status 1 |
| Claim tx (delivery) | mined at T+1 min 37 s, status 1 |
| USDC Transfer | Satora HTLC → the owner's wallet, native USDC (`0x3c499c…3359`, chain 137) |
| Amount on chain | ≥ the 300000 target: the recipient received slightly more, under 0.001 USDC (cause not verified) |
| Cross-check | Two independent RPC providers agree: a single incoming USDC transfer |
| Finality | 256 confirmations reached at T+8 min 01 s |
| Proof stored | `evm_erc20_transfer`, `confirmations-256`, at T+8 min 40 s |
| Pilot switch | ENABLED about 3.5 min before T → DISABLED shortly after funding |

Audit trail (7 transitions, every one recorded):

```
T+0 s        QUOTED → SWAP_CREATED                    owner       SWAP_ATTACHED
T+5 s        SWAP_CREATED → AWAITING_NIM_APPROVAL     owner       HANDOFF_AUTHORIZED
T+25 s       AWAITING_NIM_APPROVAL → LIGHTNING_HANDOFF owner      CLIENT_REPORTED_INITIATED
T+34 s       LIGHTNING_HANDOFF → CLIENT_FUNDED        reconciler  PROVIDER_CLIENTFUNDED
T+44 s       CLIENT_FUNDED → SERVER_FUNDED            reconciler  PROVIDER_SERVERFUNDED
T+1 min 32 s SERVER_FUNDED → CLAIMING                 owner       CLAIM_AUTHORIZED
T+8 min 40 s CLAIMING → DELIVERED                     reconciler  SETTLEMENT_VERIFIED
```

## "Finishing delivery" about 2 minutes after the claim — normal, but badly explained

**Why the wait was correct.** Thence writes `DELIVERED` only with the ERC20 Transfer proof
**and** finality (`settlement.ts`; on 2026-11-05 the Polygon policy was 256 confirmations).
About 2 minutes after the claim it had about 70 confirmations, so `verify-settlement` correctly
answered "not final yet". OKX displays a balance from the first confirmation; Thence must not,
and did not.

**Server side: correct.**
- The 256th confirmation landed at T+8 min 01 s.
- The next Hermes run verified it and wrote `DELIVERED` 39 s later.

**Client side, from the request log:**
- The Send screen verified three times, between T+2 min 07 s and T+2 min 39 s.
- The owner then left for OKX. The page was hidden, so the tracker paused, by design.
- The app returned at T+3 min 51 s through **`/app/reconnect` and a fresh wallet sign-in**.
- Activity ran one reconcile/verify round, and no further client request followed. That fits
  the page being hidden again, not a stuck verifier.

**Not a stuck status, a stuck *explanation*.** The screen said "Finishing delivery / Almost
there" next to "Action needed — Finish delivery" (already done) and a static "Approve the NIM
payment" timeline. It never said it was waiting for Polygon confirmations, and lists didn't
refresh on return to the foreground.

Fixed in the mobile payment UX change: one status-driven view, finality wording and a foreground
refresh. Since 2026-11-07, Polygon finalized-tag settlement makes Delivered follow the claim
within seconds (`docs/POLYGON_FINALITY.md`).

## Findings that needed owner decisions

1. **Nimiq Pay iOS dropped Thence's persistent session cookie** when the owner switched to OKX
   and back.
   - The server session (created about 36 s before T) was valid and not revoked; the cookie
     `Max-Age` is 30 days.
   - This does **not** show whether IndexedDB (the claim secret, until Finish delivery)
     survives an app switch. There is no evidence either way.
   - It is tracked separately as an unresolved recovery risk with a no-money device check:
     `docs/RISK_IOS_WEBVIEW_STORAGE.md`.
   - Until it's checked: stay in Nimiq Pay between approval and Finish delivery.
2. **The recipient received slightly more than the 300000 target.** The over-delivery to the
   recipient was under 0.001 USDC; the verifier accepts ≥ target by design. Worth confirming
   with Satora whether the lock amount is rounded up.
3. **Resolved since:**
   - the Neon owner credential was rotated on 2026-11-06;
   - production moved to the Hermes VPS with an explicit payment mode, so the old Vercel pilot
     variable no longer governs production.
