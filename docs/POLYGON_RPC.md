# Polygon RPC for chain verification (`THENCE_EVM_RPCS_JSON["137"]`)

Thence reads Polygon through ONE configured HTTPS RPC for every chain proof:
P4 expired-unfunded closure (`verifyNoHtlcActivity`), refund verification
(`verifyHtlcRefund`), and settlement/claim delivery proof
(`verifySettlementCore`). Every reader is fail-closed: any failed or doubtful
read is `UNAVAILABLE`/`INCONCLUSIVE`, never "no activity" and never
`DELIVERED`. There is no built-in default endpoint.

## Requirements an endpoint must meet

| Need | Used by | Minimum |
|---|---|---|
| `eth_getLogs` by address + topic[1] | P4 scan, refund fallback scan | **2000-block range** per query (`HTLC_LOG_CHUNK_BLOCKS`) |
| `eth_getBlockByNumber` (genesis, historical, latest) | P4 block search (~56 sequential reads) | no archive restriction on headers |
| `eth_getTransactionReceipt`, `eth_getTransactionByHash` | settlement, claim and refund proof | historical receipts |
| `eth_blockNumber`, `finalized` tag | confirmations / finality | current head |
| Sustained sequential reads | one P4 close ≈ 64 requests in ~15 s | no burst rejection at that rate |

## Incident: P4 close refused in production (2026-11-04 22:42Z)

The owner's "Close expired payment" for eddaa6de returned
`CHAIN_UNAVAILABLE` twice. Root cause (confirmed in the provider's request
logs): the configured endpoint was **Alchemy Free**, which rejects
`eth_getLogs` over more than **10 blocks** (`eth_getLogs` HTTP 400,
JSON-RPC `-32600`; block reads HTTP 200). The scan's 2000-block chunks
could never succeed on that plan. The code swallowed the error, so the
cause was invisible in Vercel logs; PR "P4: report the failing chain read
(sanitized)" adds `thence-chain-scan` / `thence-p4-close-refused` lines
with the failing operation, HTTP status, JSON-RPC code and a short reason —
RPC URLs and key-like tokens stripped. Verdicts and gates are unchanged.

## Candidate evaluation (2026-11-05, read-only, exact production code)

Tool: `e2e/.run/rpc-diagnose.ts` (operator, gitignored): URL read from an
owner-only file and never printed; ~35 bounded single-attempt requests;
exact P4 scan only when every basic check passes. Positive control:
077770a1's funded+refunded HTLC (must be FOUND), negative: eddaa6de (must
be NO_ACTIVITY).

| Endpoint (keyless) | getLogs range | Control found | Receipt / tx / finalized | 20-read burst | Exact P4 scan |
|---|---|---|---|---|---|
| **Tenderly gateway** `polygon.gateway.tenderly.co` | 2000 ✓ | ✓ | ✓ / ✓ / ✓ | 0 failures | **3/3 NO_ACTIVITY (~13 s) + 3/3 control ACTIVITY_FOUND** |
| **PublicNode** `polygon-bor-rpc.publicnode.com` | 2000 ✓ | ✓ | ✓ / ✓ / ✓ | 0 failures | **3/3 NO_ACTIVITY (~15 s) + 3/3 control ACTIVITY_FOUND** |
| dRPC public | rejected at 500 ("free plan") | ✓ | ✓ | 0 | not run |
| 1rpc | 50-block limit; ~108k blocks behind | ✓ | ✗ | 1 | not run |
| Ankr | API key required | — | — | — | — |
| polygon-rpc.com | 401 "tenant disabled" | — | — | — | — |
| llamarpc, meowrpc | unreachable | — | — | — | — |
| Alchemy Free (previous) | 10 blocks | — | — | — | fails |

## Decision (owner, 2026-11-05)

Controlled release uses the **keyless Tenderly Polygon Mainnet gateway**;
**PublicNode is the fallback**. Production value:

```
THENCE_EVM_RPCS_JSON={"137":"https://polygon.gateway.tenderly.co"}
```

Keep the variable type **Sensitive** in Vercel even though this URL holds no
credential (consistent handling; a later keyed URL would). Fallback value:
`{"137":"https://polygon-bor-rpc.publicnode.com"}`. Env changes apply only
to the next deployment.

## Risks of a shared public RPC (accepted for the controlled pilot)

- **Shared rate limits:** keyless endpoints rate-limit per source IP; Vercel
  functions egress from shared IPs, so other tenants can consume the limit.
  Failure mode is fail-closed (`CHAIN_UNAVAILABLE` / `UNAVAILABLE`, payment
  stays open) and now visible in logs. Remedy: retry later, or switch to the
  fallback (env update + redeploy).
- **No SLA, no request logs, no account:** changes in the operator's limits
  or availability are unannounced. Re-run the diagnostic before relying on
  it after any long gap; watch for `thence-chain-scan` lines.
- **Single source of chain truth:** a dishonest or broken RPC could answer
  falsely. P4 additionally requires the provider's own fresh "expired, no EVM
  transaction" evidence, the pinned HTLC contract, and finality depth; a
  delivery proof requires an exact receipt/log match for the bound swap.
  Cross-checking two independent RPCs is a later hardening step.
- **Latency:** a P4 close takes ~13–16 s (Vercel default timeout 300 s,
  Fluid, iad1). The settlement/refund paths make far fewer calls.

## Verifying an endpoint before any production change

1. Put the URL (one line) in `~/.thence/polygon-rpc-url`, owner-only ACL.
2. `npx tsx --env-file=.env e2e/.run/rpc-diagnose.ts` — every check must
   pass; the exact P4 scan must return `NO_ACTIVITY`.
3. Optional repeat test: `e2e/.run/rpc-repeat.ts <file>` — 3/3 negative
   `NO_ACTIVITY` and 3/3 positive `ACTIVITY_FOUND`.
