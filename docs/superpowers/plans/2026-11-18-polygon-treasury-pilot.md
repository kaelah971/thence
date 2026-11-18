# Polygon Treasury Pilot Implementation Plan

**Approved flow:** November 18 conversation: exact-receive Polygon USDC, ordinary NIM deposit, server verification, automatic treasury payout, durable recovery and receipts. Arbitrum/Base follow later. Existing Satora payments keep their recovery paths.

**Goal:** Implement an isolated, disabled-by-default treasury pilot without deploying or moving real funds.

**Architecture:** New desk orders and reservation ledger, separate from Lightning transfers. Owner-scoped API and page. Serialize reservation and payout preparation across processes with PostgreSQL advisory locks. Persist signed Polygon transaction before broadcast; retries broadcast identical bytes. No replacement transaction or automatic refund while payout outcome is uncertain. Quote reservations expire only before authorization; authorized orders retain funds pending resolution.

**Configuration:** Polygon native USDC only, chain 137. Intended payout wallet 0x21e5fc03e4305cc8cfb874253c6d66a8bdb0bcda. Collection NIM address NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ. Dedicated server signing key must match configured payout address. Pilot owner allowlist required. Default maximum 5 USDC, 0.30 minimum, 0.5% desk fee, 60-second quote. These are implementation defaults, adjustable before activation. Fresh CoinGecko input is used by a separate desk pricing adapter; legacy display-only rates and sats quotes remain unchanged.

**Recovery:** Unknown NIM submissions never unlock another payment prompt. Unknown EVM broadcast never frees a reservation or causes a new payment. Finalized reverted payout queues refund. Late deposit queues refund. NIM refunds initially require an operator to send from the user's collection wallet, with verified on-chain refund evidence before closing; automatic NIM signing is outside this pilot until separately configured. No private keys in the database or browser.

**Tech Stack:** Existing Next.js route handlers, pg, viem, Nimiq proof helpers, React, Vitest.

## Tasks
- [x] Add pure pricing/policy tests; observe failure, then implement.
- [x] Add PostgreSQL schema/migration for orders, audit events, unique source hashes, signed payout bytes and reservations; concurrency tests on isolated TEST database.
- [x] Add NIM ordinary-deposit proof using existing owner-signature and macro-finality checks.
- [x] Add quote, authorize, report, owner status and cron processing endpoints. Kill switch stops new authorizations, never recovery.
- [x] Add gated pilot page with custody disclosure, exact review, single wallet prompt and resumable status. No independent loop in existing payment tracker.
- [x] Add configuration/operator documentation and targeted verification. Never apply production migrations or deploy in this task.

## Review focus
Wrong sender/amount/memo/chain; concurrent oversubscription and nonce allocation; crash before/after broadcast; expired quote with late deposit; disabled new funding with in-flight recovery.

## Execution ledger
- Repo: C:/dev/thence-public-release, branch feat/polygon-treasury-pilot. Existing untracked incident scripts preserved.
- Read current Next route handler guide before code changes.
- Ruling: user approved the flow and instructed us to start; do not repeat design approval. Wallet details may be supplied while implementation continues.
- Task 1: policy/handoff tests observed failing before implementation; now pass. Strict native USDC/Polygon policy and distinct desk rate adapter added.
- Task 2: migration 0019 generated, reviewed and applied only after non-production anchor guard. No production migration. Real TEST DB concurrency/recovery tests exercise reservations and durable signed bytes; all chain effects mocked.
- Task 3: exact NIM proof and positive-only memo discovery added without modifying legacy verifier behavior. Supplied NQ address checksum passes.
- Task 4: owner API and separate authenticated money-moving worker; legacy reconciler unchanged. Ruling: use environment pause for this isolated private pilot; it requires service environment reload, documented before activation.
- Task 5: custody disclosure, single prompt grant, resumable pending UI and receipts. No second lifecycle loop added to legacy tracker. Production-server Chromium QA passed with fake data.
- Review: fresh reviewer found worker starvation and wrong-hash discovery suppression. Reproduced both as failing tests, fixed and re-reviewed; no new Critical/Important findings.
- Ruling: add owner-requested return queue for a verified deposit before any payout is signed. This supports gas-estimation/signer failures safely under the same signing lock. No automated NIM refunds.
- Verification: typecheck, lint and build pass; existing Next.js/dependency advisories remain. Full suite in progress; older settlement test's 10-case loop exceeded its 300-second budget, followed by a setup 503. Investigate without weakening assertions.
- Verification follow-up: stopped the failed full-project run and split the settlement loop into sequential it.each cases with unchanged assertions and independent cleanup/time budgets. Targeted settlement21 + treasury ledger5 passed. All42 other treasury tests passed (47 new pilot tests total). Full-project suite remains incomplete, not claimed green.
- Ruling: fixture claim hashes need a short case tag because claimTxFor truncates to 32 bytes. Added a RUN-preservation assertion, observed nine long-label failures, then used a short case index. Final targeted invalid-settlement rerun: 11 passed, 10 intentionally filtered out. Final typecheck and lint also passed.
- Completion: local pilot implementation and scoped verification complete. Full-project suite remains incomplete; no deployment/production migration/secrets/mainnet transactions. No additional deferred reviewer findings; activation prerequisites and dependency advisories remain documented rollout work.
- Activation: signer, trusted NIM proof RPC, scheduler, production migration/deployment and a separately approved small live payment remain outstanding. No production changes or real signing/broadcasts performed.
