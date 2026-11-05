# First supervised mainnet payment — 2026-11-05 (2c2432af) — DELIVERED

Read-only postmortem. No funds were moved, no claim replayed, no handoff
repeated and no setting changed to produce it. Personal identifiers are
omitted or masked. Transaction hashes are masked too (an explorer would show the
full wallet); block numbers are kept for audit. Full hashes: operator records.

## Outcome

**Delivered and independently verified.** 0.30 native USDC (Polygon) reached
the owner's wallet `0x17de…5a15` in one approval, one claim and one transfer.

| Fact | Value |
|---|---|
| Transfer | `2c2432af…`, route `usdc-polygon`, target `300000` atomic |
| Swap | Lightning → Polygon, 380 sats, Polygon claim deadline 10:30:10Z |
| NIM debit (owner, Nimiq Pay screen) | ≈ 985.45 NIM — under the 1,900 NIM ceiling |
| Funding tx (provider HTLC) | `0x1385…4091` (full hash in operator records), block 96777064, 09:30:52Z, status 1 |
| Claim tx (delivery) | `0x7797…0f34` (full hash in operator records), block 96777101, 09:31:48Z, status 1 |
| USDC Transfer | log 712: HTLC `0xdb76…bff0` → `0x17de…5a15`, token `0x3c499c…3359` (native USDC, chain 137) |
| Amount on chain | **300394 atomic** (0.300394 USDC) — ≥ 300000 target (+394 atomic to the recipient; cause not verified) |
| Cross-check | Tenderly and PublicNode agree: single incoming USDC transfer; balance 0 → 300394 |
| Finality | 256 confirmations reached at block 96777357, **09:38:12Z** |
| Proof stored | `evm_erc20_transfer`, `confirmations-256`, 09:38:51Z |
| Pilot switch | ENABLED 09:26:48Z → DISABLED 09:30:58Z (12 s after funding) |

Audit trail (7 transitions, every one recorded):

```
09:30:11 QUOTED → SWAP_CREATED               owner       SWAP_ATTACHED
09:30:16 SWAP_CREATED → AWAITING_NIM_APPROVAL owner       HANDOFF_AUTHORIZED
09:30:36 AWAITING_NIM_APPROVAL → LIGHTNING_HANDOFF owner  CLIENT_REPORTED_INITIATED
09:30:45 LIGHTNING_HANDOFF → CLIENT_FUNDED   reconciler  PROVIDER_CLIENTFUNDED
09:30:55 CLIENT_FUNDED → SERVER_FUNDED       reconciler  PROVIDER_SERVERFUNDED
09:31:43 SERVER_FUNDED → CLAIMING            owner       CLAIM_AUTHORIZED
09:38:51 CLAIMING → DELIVERED                reconciler  SETTLEMENT_VERIFIED
```

## "Finishing delivery" at 10:34 Lagos (09:34Z) — normal, but badly explained

The claim was mined at 09:31:48Z. Thence writes `DELIVERED` only with the
ERC20 Transfer proof **and 256 confirmations** (`settlement.ts`, Polygon
finality policy). At 09:34Z the claim had ≈ 70 confirmations, so
`verify-settlement` correctly answered "not final yet". OKX displays a
balance from the first confirmation; Thence must not, and did not.

- 09:38:12Z the 256th confirmation landed; the Hermes run at 09:38:50Z
  verified it and wrote `DELIVERED` 39 s later. Server side: correct.
- Client side (Vercel request log, 10:29–10:41 Lagos): the Send screen
  verified three times (10:32:18–10:32:50), then the owner left for OKX
  (page hidden → tracker paused, by design). The app returned at 10:34:02
  through **`/app/reconnect` and a fresh wallet sign-in**, Activity ran one
  reconcile/verify round (10:34:17–10:34:22) and no further client request
  followed — consistent with the page being hidden again, not a stuck
  verifier.
- **Not a stuck status.** It was a stuck *explanation*: the screen said
  "Finishing delivery / Almost there" next to "Action needed — Finish
  delivery" (already done) and a static "Approve the NIM payment" timeline,
  and never said it was waiting for Polygon confirmations. Lists also did not
  refresh on return to the foreground. Fixed in the mobile payment UX change
  (one status-driven view; finality wording; foreground refresh).

## Findings that need owner decisions (not changed here)

1. **Nimiq Pay iOS dropped Thence's persistent session cookie** when the owner
   switched to OKX and back (server session 09:29:35Z was valid and not
   revoked; cookie `Max-Age` = 30 days). This does **not** show whether
   IndexedDB (claim secret, until Finish delivery) survives an app switch —
   there is no evidence either way. Tracked separately as an unresolved
   recovery risk with a no-money device check: `docs/RISK_IOS_WEBVIEW_STORAGE.md`.
   Until checked: stay in Nimiq Pay between approval and Finish delivery.
2. **Recipient amount was 300394, not exactly 300000.** Over-delivery to the
   recipient (+0.000394 USDC); the verifier accepts ≥ target by design.
   Worth confirming with Satora whether the lock amount is rounded up.
3. Unchanged and still open: the exposed Neon owner credential (owner
   decision, deferred); Vercel `THENCE_PILOT_ENABLED=1` remains deployed
   (database switch is DISABLED, so new funding is blocked).
