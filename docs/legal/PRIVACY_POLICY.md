# Thence Privacy Policy

> **DRAFT — not legal advice and not reviewed by a lawyer.** Prepared on 2026-11-06 from the
> code at `main`. Placeholders in `[brackets]` must be completed by the operator, and the
> document must be reviewed by qualified counsel for the operator's jurisdiction before it is
> published or relied on.

**Last updated:** [DATE OF PUBLICATION]

## 1. Who we are

Thence ("Thence", "we", "us") is a Mini App that runs inside the Nimiq Pay wallet. It lets you
pay in NIM so that a recipient receives a stablecoin (currently USDC on Polygon).

- **Operator:** [LEGAL NAME OF OPERATOR]
- **Address:** [ADDRESS]
- **Privacy contact:** [EMAIL]

## 2. The short version

- You sign in with your Nimiq wallet. We don't ask for your email, phone number, government ID
  or bank details.
- We store what we need to run payments: your Nimiq address, the names and wallet addresses you
  save, and the record of each payment.
- **Thence never holds your funds or your swap secrets.** Swap secrets are generated and stored
  on your device.
- Blockchain transactions are public and permanent. We can't delete them.
- We don't sell your data, show ads or use third-party analytics or tracking cookies.

## 3. Information we process

### 3.1 Information you provide or create

| Data | Why | Stored where |
|---|---|---|
| Nimiq wallet address | Account identity and sign-in | Our database |
| Display name (optional) | Personalising the app | Our database |
| Recipient names, wallet addresses, network/asset and labels | Your address book | Our database |
| Wallet-ownership verification signatures | Showing a "verified" badge for a recipient wallet | Our database |
| Payment requests (recipient name, destination, amount, memo, expiry) | Creating shareable request links. **Anyone with the link can see the request details.** | Our database |
| Payment records (amount, route, destination, quote, status, timestamps) | Executing, tracking and recovering payments | Our database |

### 3.2 Information created when you pay

- The swap identifier, Lightning invoice payment hash, amounts and deadlines from the swap
  provider.
- Public blockchain data: transaction hashes, block numbers, token transfers and confirmations.
- An audit trail of payment status changes. It records who triggered each change: you, or our
  automatic reconciler.

### 3.3 Information collected automatically

- **Session cookie.** A random token, stored by us only as a one-way hash. It keeps you signed in
  for up to 30 days. It is strictly necessary, HttpOnly, and has no tracking purpose.
- **IP address.** Used briefly as a rate-limit key for requests from people who aren't signed in.
  These counters are deleted after about one hour. Signed-in requests are rate-limited by
  account, not IP.
- **Server logs.** Our hosting and network providers keep standard request logs (IP address,
  time, URL and user agent) for operations and security, under their own retention.

### 3.4 Information stored only on your device

Thence and the swap software store some data in your device's browser storage (IndexedDB and
localStorage) inside Nimiq Pay:

- swap keys and secrets, which are needed to finish delivery or recover a payment;
- a recovery binding for each payment, and a local activity archive.

This data **is not sent to us**. If you clear app data, uninstall Nimiq Pay or lose your device,
it is lost, and we can't restore it.

### 3.5 What we don't collect

We don't collect your NIM private keys or seed phrase, your email, phone or government ID, your
precise location, or your contacts.

## 4. How we use information

We use information:

- to provide the service: sign-in, quotes, payments, delivery verification, receipts and
  payment requests;
- to recover payments and detect refunds;
- to keep the service secure and prevent abuse, including rate limiting and fraud prevention;
- to troubleshoot and improve reliability;
- to comply with law.

[COUNSEL: state the lawful bases, e.g. contract performance and legitimate interests (security),
if GDPR or UK GDPR applies.]

## 5. Third parties

| Party | Role | What they receive |
|---|---|---|
| **Nimiq Pay** (wallet host) | Runs the Mini App, signs messages and pays Lightning invoices from your NIM | Governed by Nimiq Pay's own terms and privacy policy |
| **Satora** (swap provider) | Converts the Lightning payment into the destination stablecoin | Your browser sends the swap request directly: amount, destination address, invoice and your IP address |
| **Blockchain networks** (Lightning, Polygon) | Settlement | Public transactions, visible to anyone |
| **Blockchain data providers** (public RPC nodes) | Reading on-chain status | Transaction and address lookups |
| **Hosting, database and network providers** [LIST CURRENT PROVIDERS] | Running the service | All server-side data, as our processors |

We disclose information to authorities only when the law requires it.

## 6. Public blockchain data

Payments create permanent public records: the recipient address, amounts and timestamps.
Anyone can link these to other activity of the same address. Thence can't change or delete
on-chain data.

## 7. Retention

- **Account, address book and payment records:** kept while your account is active, and then
  for [PERIOD] for dispute, accounting and legal purposes.
- **Rate-limit counters:** about 1 hour.
- **Expired sign-in challenges and sessions:** [PERIOD / "deleted periodically"].
- **Payment audit trails:** kept for [PERIOD], because they are needed to investigate funds.

[OPERATOR: an automated deletion process for inactive accounts does not exist yet. Either build
one or describe the manual process.]

## 8. Your choices and rights

You can edit or archive recipients and cancel payment requests in the app. You can ask us for
access to, correction of or deletion of your data at [EMAIL]. Records needed to resolve an
in-flight payment or to meet legal obligations may be kept. On-chain data can't be deleted.

[COUNSEL: add jurisdiction-specific rights (GDPR/UK GDPR, CCPA, NDPA, etc.) and the right to
complain to a supervisory authority.]

## 9. Security

- Sessions are hashed.
- Cookies are HttpOnly and Secure.
- Sign-in uses wallet signatures, so there are no passwords.
- Request origins are checked and requests are rate-limited.
- Database credentials are least-privilege and rotated.
- Swap secrets are kept on your device.

No system is perfectly secure.

## 10. Children

Thence is not intended for anyone under 18.

## 11. International transfers

Our providers may process data outside your country. [COUNSEL: describe safeguards, if
required.]

## 12. Changes

We will post updates here and change the "Last updated" date. If a change is material, we will
also tell users in the app.

## 13. Contact

[EMAIL / ADDRESS]
