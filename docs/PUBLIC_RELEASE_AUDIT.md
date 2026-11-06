# Public release audit: repository secrets and sensitive data

- **Date:** 2026-11-06
- **Scope:** every commit reachable from every branch (142 commits) of `kaelah971/thence`,
  plus the working tree at `main` (`14be41d`).
- **Repository visibility:** **PRIVATE**. Don't change it without explicit owner approval.

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

## Before making the repository public (owner checklist)

1. [ ] VPS migration finished. The owner explicitly approves the visibility change.
2. [ ] Run `gitleaks detect --log-opts="--all"` and get a clean result.
3. [ ] Recommended: credential rotation plan Phase 3 (delete or protect the historical Vercel
       deployments that bundled the dead `.env`).
4. [ ] Confirm that Vercel Deployment Protection covers preview URLs.
5. [ ] Enable GitHub secret scanning and push protection. They're free for public repos.
6. [ ] Add branch protection on `main`: PR plus green CI required.
7. [ ] Decide whether the 2026-11-05 block numbers stay in `README.md`,
       `docs/hackathon/EVIDENCE.md` and the pilot doc. With the USDC contract, they make the
       owner's transaction, and therefore the owner's wallet, findable on an explorer.
8. [ ] Optional: remove `docs/pr-assets/` (PR evidence) and the internal planning docs, or keep
       them as an honest engineering record.
