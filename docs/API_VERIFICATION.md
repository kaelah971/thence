# Thence — Recipient Verification API (B2.3)

A payer saves a beneficiary; the **recipient** — who needs no Thence account —
proves control of the saved EVM address by signing a bound challenge with
their own wallet (EIP-191 `personal_sign`). Verification attests **wallet
control only**, never name or legal identity.

Frontend flow this backend supports:

1. Payer opens a recipient → destination → **Verify** → backend returns
   `{ token, url, message }`.
2. Payer shares `url` (`/v/<token>`) with the recipient (any channel).
3. Recipient opens the link, reviews the exact message, signs with an EVM
   wallet. Only the shown address/asset/network is proven; the message
   states signing authorizes no payment or fund movement.
4. Backend recovers the signer, binds proof on match → payer sees
   `verified-by-recipient`.
5. Frontend offers “Resend link” (new challenge) or proceeds to Send.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/recipients/:id/destinations/:destId/verify-start` | cookie (owner) | Start verification for an owned, unarchived, valid-EVM destination → 201 `{ verification: { token, url, message, address, asset, network, expiresAt } }`. Repeatable (new challenge each time) |
| GET | `/api/verify/:token` | **none (public)** | Review terms: `{ status: active\|used\|expired, recipientName, address, asset, network, message? (active only), expiresAt }`. No owner ids, no session data. `Cache-Control: no-store`. Unknown → 404 |
| POST | `/api/verify/:token` | **none (public)** | Submit `{ signature: "0x…" }` (65-byte EIP-191 signature). Success → 200 `{ verified: true, address, verifiedAt }` and the destination shows `verified-by-recipient`. **No session is ever created for the signer** |

State-changing endpoints enforce same-origin (403 on forged `Origin`),
an 8 KB JSON body cap (413), and DB-backed per-client throttles
(`verification-write` for start, `verification-public` for public
endpoints; 429 + `Retry-After`).

## Method and guarantees

- EIP-191: the wallet prefixes `"\x19Ethereum Signed Message:\n" + len +
  message`; the backend recovers via maintained **viem**
  `recoverMessageAddress` and requires equality with the bound address.
  Nimiq's Ed25519 verifier is never used for EVM addresses.
- Only EOAs can pass: contract wallets cannot produce an ECDSA signature
  recovering to themselves (no ERC-1271 in this slice — documented limit).
- Tokens are 128-bit bearer secrets: only SHA-256 hashes stored.
  Challenges are short-lived (default 1h), single-use, atomically consumed
  (concurrent submissions → exactly one winner; losers get 410).
  Restarting verification supersedes earlier pending links for the same
  destination (they resolve as used). One active process per destination
  is enforced by a partial unique index; consumed proofs are kept as history.
- Proof attaches to the specific saved destination (`destination_id`).
  Changing address/asset/network clears the badge and drops the orphan
  proof. Deleting a destination cascades its proofs. Archiving freezes
  writes (completion on archived records → 409); archived verified badges
  are kept as historical fact, not re-verified.
- Wrong signer → 401 `SIGNER_MISMATCH` (challenge NOT consumed, retryable);
  malformed → 401; unknown → 404; used → 410 `CHALLENGE_USED`;
  expired → 410 `CHALLENGE_EXPIRED`; changed/vanished destination → 409.

## Still pending

- A real browser-wallet `personal_sign` round trip (needs the frontend +
  an EVM wallet; backend fixtures use viem local accounts with an
  independent secp256k1+keccak cross-check).
- ERC-1271 contract-wallet support (deliberately out of scope).
- Recipient-initiated or QR-based verification UX (frontend slices).
