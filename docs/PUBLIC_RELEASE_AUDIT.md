# Public release audit: repository secrets and sensitive data

- **Date:** 2026-11-06; **final review 2026-11-07**
- **Scope:** every commit reachable from every branch (161 commits at the final review) of
  `kaelah971/thence`, plus the tracked working tree.
- **Repository visibility:** **PUBLIC** since 2026-11-07 (owner approved after this review).

## Method

1. Exported the full history with `git log --all -p`, so deleted files are included.
2. Pattern-scanned every added line for:
   - credentials: Postgres URLs with passwords, Neon `npg_` passwords, private-key blocks, AWS,
     GitHub and Slack tokens, JWTs, Cloudflare tunnel tokens and generic `secret|token|api_key|
     password = …` assignments;
   - infrastructure identifiers: Vercel `prj_`/`team_`/`dpl_`, Neon `br-`/`ep-`, hostnames,
     usernames, home paths and IPs;
   - personal data: emails, full EVM and Nimiq addresses and 32-byte hashes.
3. Reviewed every hit manually. The automated scanners (gitleaks and trufflehog) were not
   installed, so the scan used an equivalent regex set. **Recommendation:** run
   `gitleaks detect --log-opts="--all"` once before the repository is made public.

## Results

| Category | Result |
|---|---|
| Live credentials (DB passwords, API keys, tokens, private keys) | **None found** in any commit |
| Postgres URLs | All are placeholders (`postgres:postgres@localhost`) or test fixtures (`fake-prod-pw@….invalid`) |
| `.env` files | Never committed. `.gitignore` and `.vercelignore` exclude them |
| Wallet addresses | Test fixtures (`NQ07 0000…`, `0x7e57…`), public contracts (USDC, Satora HTLC, WBTC), or public on-chain data in the redacted incident fixture. The owner's wallet appears only masked (`0x17de…5a15`) |
| Transaction hashes | The pilot doc keeps them masked. The incident fixture holds public Polygon data on purpose (redaction notes in its `_meta`) |
| 64-hex values | SHA-256 checksums of the Node.js and cloudflared downloads (`ops/selfhost/setup-root.sh`) and test vectors |
| CI | One secret, `THENCE_TEST_DATABASE_URL`, is referenced via `${{ secrets.* }}`. Forked PRs don't receive it (`pull_request` trigger) |

## Low-severity information (not credentials) — owner awareness

These items stay in the history even though `HEAD` has been cleaned. Removing them from the
history would require a rewrite. That isn't recommended, because none of them grants access.

| Item | Where | Risk / action |
|---|---|---|
| Neon branch and endpoint IDs (`br-…`, `ep-…`) | `docs/RELEASE_PREFLIGHT.md`, `docs/CREDENTIAL_ROTATION_PLAN.md` | Useless without credentials. The exposed credential was rotated and verified dead (rotation plan, execution record) |
| Vercel deployment IDs (`dpl_…`) | Same docs, `docs/S0_SECURITY_LOG.md` | Old deployments contain a **dead** `.env`. Phase 3 (deleting historical deployments) is **still not executed**: recommended before going public, as defence in depth |
| Personal home path of the VPS user (planning docs) | `docs/Thence messaging.md`, `docs/Thence_PRD_Architecture_Build_Plan.md`, `docs/Thence_Product_Idea.md` | **Redacted in HEAD** on this branch. Still in history (username only) |
| Self-hosting layout (systemd units, service users, sudoers, loopback ports, tunnel name, `vps.` hostname) | `ops/selfhost/` | Standard deployment-as-code. It holds no keys or IPs of the VPS. The token file path is referenced, not its contents |
| Public domain and DNS facts (Vercel A/CNAME records, nameserver names) | `ops/selfhost/PRODUCTION_CUTOVER.md` | Public DNS data |
| Mentions that other services share the VPS | `ops/selfhost/*` | Minor reconnaissance value. Optional: reword after the migration |

## Hardening applied on this branch

- `.gitignore` now also excludes `.env.*` (except `.env.example`), keys and certificates,
  cloudflared credentials, `*.env` files and local scratch output.
- CI workflow: `permissions: contents: read`, so jobs run with a least-privilege
  `GITHUB_TOKEN`.

## Final review, 2026-11-07 (Gitleaks 8.30.1, official release, checksum verified)

**Gitleaks runs:**
- `gitleaks git . --log-opts="--all" --redact`: 34 findings in history.
- `gitleaks dir .`: 32 findings in tracked files.

**Every finding was triaged as a false positive** of the heuristic `generic-api-key` rule:
- public token contracts (native USDC `0x3c49…3359` and USDT `0xc213…8e8f` on Polygon);
- browser storage key names (`thence.f4.*`);
- Satora's public token catalogue fixture;
- test idempotency keys;
- a comment in `ops/selfhost/sudoers-thence`.

**No credential, key or token exists in any commit.** Findings in untracked build output
(`.next*`) and local env files are not published; `.env*` is ignored, except `.env.example`.

**Privacy sweep (beyond Gitleaks):**
- **No full personal wallet address appears anywhere.** The full addresses that appear are
  public contracts, provider addresses or test fixtures.
- The 2026-11-02 incident fixture keeps public on-chain data. Its swap-client addresses are
  per-swap keys, and that swap was refunded, so it never touched the owner's wallet.
- Removed from the docs, the test comments and the `HEAD` of the README:
  - the 2026-11-05 block numbers;
  - the masked transaction hashes;
  - the masked owner wallet;
  - exact on-chain amounts;
  - the exact NIM debit;
  - second-level timestamps for the 2026-11-05 and 2026-11-06 payments.

  The evidence for judges is kept as relative timings, ≥ target amounts and verification
  method.

**Residual, accepted, and not fixable without a history rewrite:**
1. Commits before 2026-11-07 still contain the block numbers, masked hashes and exact amounts
   of the 2026-11-05 payment. Anyone reading the history can find that transaction and the
   recipient wallet.
2. Even with `HEAD` cleaned, the date, an approximate amount and the public Satora HTLC
   contract narrow the search on an explorer. Satora's volume is low.

3. The VPS deploy account's username is the default in `ops/selfhost/setup-root*.sh` (low
   severity: not a credential, SSH is key-based, and it's already in history).

**Mitigation, if wallet privacy matters:** use a fresh recipient wallet for demos and future
tests, and treat the 2026-11-05/06 recipient wallet as public. A history rewrite (or publishing
a fresh-history copy) is possible, but it's destructive and is the owner's call.

## Before making the repository public (owner checklist)

1. [x] VPS migration finished (2026-11-06); the owner approved the visibility change (2026-11-07).
2. [x] Gitleaks run on the full history (2026-11-07): no secrets (false positives triaged above).
3. [~] Kept by owner decision (rollback). Mitigated: the old deployments require Vercel login (item 4), and the credentials they bundled are rotated. Was: credential rotation plan Phase 3 (delete or protect the historical Vercel
       deployments that bundled the dead `.env`).
4. [x] Vercel Authentication covers all deployments except custom domains (`ssoProtection: all_except_custom_domains`, read 2026-11-07).
5. [x] GitHub secret scanning and push protection enabled (2026-11-07).
6. [ ] Add branch protection on `main` (PR required). Don't require CI checks while GitHub Actions is blocked by billing, or merges will be impossible.
7. [x] Block numbers removed from `HEAD` (2026-11-07). History keeps them (see residual). Was: decide whether the 2026-11-05 block numbers stay in `README.md`,
       `docs/hackathon/EVIDENCE.md` and the pilot doc. With the USDC contract, they make the
       owner's transaction, and therefore the owner's wallet, findable on an explorer.
8. [ ] Optional: remove `docs/pr-assets/` (PR evidence) and the internal planning docs, or keep
       them as an honest engineering record.
