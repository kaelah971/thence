# A3d.6 — Historical proof recovery (NOV6, NOV7)

Operator-only recovery of independent NIM source evidence for the two
already-delivered November 6 and 7 payments, so the existing Global Proof Feed
can publish them once the owner opens the gate. Nothing here publishes.

## What is recorded

`transfer_source_evidence` (migration `0018`) is an append-only table:

- one row per verification, with the transfer id, normalized Nimiq transaction
  hash, verdict (`VERIFIED`/`REJECTED`), bounded non-secret evidence JSON,
  verifier commit, named RPC sources, finality policy id, operator reference
  and creation time;
- database-enforced uniqueness: at most one `VERIFIED` row per transfer and per
  Nimiq transaction hash;
- a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`; the foreign key is
  `ON DELETE RESTRICT`;
- evidence never contains payment hashes, invoices, preimages, owner addresses
  or credentials.

`transfer_proofs.nimiq_tx_hash` receives a separate guarded fill:
`UPDATE … SET nimiq_tx_hash = $h WHERE transfer_id = $t AND nimiq_tx_hash IS NULL`.
A non-null value is never overwritten; a different existing value blocks the
case (`CONFLICTING_SOURCE`). No status transition is inserted (DELIVERED is
terminal).

## Trust policy `a3d6-public-rpc-v1` (zero cost)

| Leg | Checked | Against |
| --- | --- | --- |
| Nimiq source | PR #64 verifier: exact hash, mainnet, successful native HTLC creation, derived contract address, **full 256-bit hash root = authenticated `swap_attachments.payment_hash`**, EarlyResolve owner signature to the authenticated wallet, exact amount, ≥ 6 confirmations, next macro block returned with a justification | `rpc.nimiqwatch.com` (Nimiq Watch open server) |
| Polygon destination | receipt success, chain 137, canonical USDC `0x3c49…3359`, full recipient = `transfers.destination`, exact amount = stored proof, block number, block hash + header continuity, log index, block ≤ `finalized` | **both** `polygon-bor-rpc.publicnode.com` and `polygon.drpc.org`, which must agree |

Fail closed on any mismatch, unavailable RPC, missing evidence or disagreement.

**Stated limitation (published with every proof):** the Nimiq macro block's
aggregate BLS validator signature is not independently verified; the named RPC
operator is the trust boundary for Nimiq finality. The open server is
documented by Nimiq as not intended for production; this policy is an explicit
hackathon-scope decision, recorded per row in `rpc_source`/`finality_policy`.

## Command

```bash
# Dry run (default; reads only). DATABASE_URL selects the database, never printed.
npx tsx scripts/recover-historical-proofs.ts

# Apply (separate owner approval; clean checkout of the reviewed commit only)
npx tsx scripts/recover-historical-proofs.ts --apply \
  --operator-ref <approval-id> --confirm NOV6,NOV7
```

- Closed allowlist: NOV6 and NOV7 only, keyed by their public Polygon and Nimiq
  transaction hashes and the A3d.3 transfer-id prefixes. No bulk import.
- Idempotent: re-running returns `ALREADY_RECOVERED`.
- Apply takes the same advisory lock key (`nimiq-source:<hash>`) as the live
  source binder, locks the transfer row, re-checks attribution, then appends
  evidence and performs the guarded fill in one transaction.
- Output is redacted: no payment hashes, owner address or full internal ids.

## Release checklist (redacted)

Each production step requires separate owner approval.

1. [ ] Review and merge PR #64 and this PR (CI-equivalent local run: typecheck,
       lint, build, full tests).
2. [ ] Deploy the merged commit to Hermes with the existing versioned
       procedure; confirm `/api/health` and `/api/proofs` → `404
       PUBLIC_PROOFS_DISABLED`.
3. [ ] Apply migration `0018` to production (owner-run,
       `THENCE_MIGRATE_PRODUCTION=I_UNDERSTAND npm run db:migrate` with the
       owner credential). Verify the table, the two partial unique indexes and
       both triggers exist.
4. [ ] Production dry run from a clean checkout of the deployed commit
       (read-only): both cases must report `READY` with
       `paymentHashMatch: full-256-bit`, `HTLC_OWNER_SIGNATURE`,
       finalized on both Polygon RPCs.
5. [ ] Production apply with `--operator-ref` and `--confirm NOV6,NOV7`;
       both report `INSERTED` and `proofHashFilled: true`; re-run reports
       `ALREADY_RECOVERED`.
6. [ ] With the gate still off, confirm via a read-only query that both rows
       satisfy the publication condition (or run the feed query locally
       against production read-only).
7. [ ] Owner decision: set `THENCE_PUBLIC_PROOFS_ENABLED=1` (hash-verified env
       install) and restart only the web service; confirm two proofs render
       with the qualified finality text and no private fields.
8. [ ] Keep Arbitrum disabled; Polygon unchanged.

Rollback: unset the publication flag (proofs disappear immediately). Evidence
rows are append-only by design; a wrongly recovered case would be superseded by
a separately approved `REJECTED` record and code that excludes it, never by
deletion.
