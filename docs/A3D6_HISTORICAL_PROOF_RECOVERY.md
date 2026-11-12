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

Each numbered step needs explicit owner approval. Stop on any unexpected
result. Arbitrum stays disabled and publication stays off until step 9.

1. **CI** — PR #65 `staging-build` green (build incl. release-shard check,
   lint, integration shards, e2e). The shared test project already carries
   migration `0018`; its CI guard requires migration count = journal length.
2. **Merge order** — merge #65 into `feat/a3d2-nimiq-finality`, then #64 into
   `main` as one push. Merging #64 alone would leave `main` at 18 journal
   entries against a 19-migration test project and fail the CI guard.
   Vercel auto-deploys `main`; that is safe with publication off because the
   proof routes return 404 before touching the database.
3. **Production migration (owner)** — as the owner role, from a clean checkout
   of the merged commit:
   `THENCE_MIGRATE_PRODUCTION=I_UNDERSTAND npm run db:migrate`. Additive only;
   the running app never queries the table while the gate is off. Verify
   read-only: the table (empty), two partial unique indexes, two triggers,
   19 tracked migrations, and
   `has_table_privilege('thence_app', 'transfer_source_evidence', 'SELECT')`
   true (granted by the existing default privileges).
4. **Hermes deploy** — existing versioned procedure; restart only
   `thence-web-production` right after a reconciler run. Verify the build id,
   `/api/health` 200 with the database reachable, `/api/proofs` →
   `404 PUBLIC_PROOFS_DISABLED`, Polygon live and quoteable, Arbitrum
   disabled, reconciler `errors:{}`.
5. **Production dry run (read-only)** — clean checkout of the deployed commit,
   `DATABASE_URL` = production `thence_app` URL injected in-process:
   `npx tsx scripts/recover-historical-proofs.ts`. Both cases `READY` with
   `paymentHashMatch: full-256-bit`, `HTLC_OWNER_SIGNATURE`, finalized on both
   Polygon RPCs.
6. **Authorized backfill** — same checkout and role:
   `--apply --operator-ref <approval-id> --confirm NOV6,NOV7`. Both
   `INSERTED` with `proofHashFilled: true`; an immediate re-run reports
   `ALREADY_RECOVERED` for both.
7. **Verify (read-only)** — exactly two `VERIFIED` evidence rows and no
   `REJECTED`; both `transfer_proofs.nimiq_tx_hash` equal the allowlisted
   hashes; no transfer status or transition changed; the feed query with the
   production config returns exactly the two proofs (run locally, gate
   untouched).
8. **Review the rendered proofs** — locally against production read-only:
   genuine NIM/USDC hashes and amounts, explorer links, method block and
   qualified finality text; no payment hash, invoice, swap id, label or owner
   id.
9. **Publication (owner decision)** — set `THENCE_PUBLIC_PROOFS_ENABLED=1` via
   the hash-verified env install, restart only the web service, and confirm
   `/api/proofs` lists the two proofs through Cloudflare.

Rollback: unset the publication flag (proofs disappear immediately). Evidence
is append-only; a wrongly recovered case is revoked by a separately approved
`REJECTED` record, which removes it from the feed without deleting history.
