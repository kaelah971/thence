# Polygon settlement finality: `finalized` tag instead of 256 confirmations

- **Status (2026-11-06):** code ready (F9.2). The production switch is a **separate, owner-run
  config step**.
- **Default unchanged:** 256 confirmations (`DEFAULT_FINALITY_POLICY[137]`).
- **Claim gate unchanged:** the 32-confirmation gate before Finish delivery
  (`CLAIM_FUNDING_MIN_CONFIRMATIONS`) is not touched here. Its replacement needs its own
  verification.

## Why

**The cost today.** On the first live public payment (2026-11-06, `1dfd7782…`):
- the claim was authorized at 21:30:34Z;
- Delivered was written at 21:38:22Z;
- the gap, about 7.8 minutes, was spent waiting for 256 Polygon confirmations.

**Why 256 was chosen.** The code comment assumed Polygon had "no trustworthy `finalized` tag".
In the old model, the tag tracked Ethereum checkpoints, about 30 minutes behind.

**What changed.** Polygon now has milestone-based finality. Bor's `finalized` tag tracks the
latest milestone, a few seconds behind the head, and finalized blocks cannot be reorganized.

## Evidence (read-only, from the Hermes VPS, production RPCs)

**Method.** Sampler `~/finsample.sh` on the VPS, every 15 s, for 3 h.
- **Providers:** PublicNode (the production RPC) and the Tenderly gateway.
- **Each sample:** `eth_blockNumber` and `eth_getBlockByNumber("finalized")`, batched. The
  finalized hash is then compared with the **other** provider's block at the same height.

| Metric (first 13 min, 104 samples) | PublicNode | Tenderly |
|---|---|---|
| Errors | 0 | 0 |
| Finalized lag behind head, min / avg / max | 1 / 2.04 / 3 blocks | 1 / 2.02 / 3 blocks |
| Finalized hash ≠ other provider's hash at that height | 0 | 0 |
| Finalized height went backwards | 0 | 0 |
| Latency (batched) | ~109 ms | ~91 ms |

The full 3-hour results are added to the PR before activation.

**Expected effect:** Delivered about **5 to 10 s** after the claim is mined (2 to 3 blocks,
plus one verify round), instead of about 8 minutes.

## Safety (what the code does in `finalized` mode, all fail-closed)

| Case | Verdict |
|---|---|
| RPC can't return the finalized block | `INCONCLUSIVE`, never Delivered |
| Claim block above the finalized block (stale or lagging RPC) | `INSUFFICIENT_CONFIRMATIONS`, retried later |
| **Finalized height above the RPC's own head** (inconsistent RPC; **new guard in F9.2**) | `INCONCLUSIVE`. Without the guard this verified, as the regression test proves |
| Block hash at the claim height differs from the receipt (reorg) | `INCONCLUSIVE` (checked before finality) |
| RPC outage | 503, nothing written |

The guard applies to both settlement and refund verification. A missed or late verdict delays
the Delivered label only. The USDC transfer itself is the on-chain claim, and refunds are
detected on the same chain.

## Production switch (owner) and rollback

The override is read on every verification, so a restart applies it. **No rebuild is needed.**

1. Add **one line** to `/etc/thence-web-prod/production.env`, through the reviewed installer
   with `--allow-payments` (payments are live). Use **single quotes**, so that systemd's env
   parser keeps the JSON's double quotes:
   ```
   THENCE_SETTLEMENT_FINALITY_JSON='{"137":{"mode":"finalized","confirmations":1}}'
   ```
2. Restart the app, then verify:
   - **App health:** `/api/health` ok and the verifier passes 17/17. An unparseable value fails
     env validation, and health shows it at once.
   - **Value in the running process:**
     `grep -c '^THENCE_SETTLEMENT_FINALITY_JSON={"137":{"mode":"finalized","confirmations":1}}$'`
     on `/proc/<pid>/environ` must print 1.
   - **Next delivery:** its proof shows `finality_level = finalized`.
3. **Rollback:** reinstall the previous file (the installer keeps a backup), or delete the line.
   Then restart. The 256-confirmation default applies again; this is covered by the
   regression test.

Proofs already stored with `confirmations-256` stay valid. Receipts are immutable.
