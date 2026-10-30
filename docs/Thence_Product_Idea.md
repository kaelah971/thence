# Thence — Product Idea

**Product:** Thence  
**Pronunciation:** `thens`  
**Descriptor:** Recipient-first cross-asset payments inside Nimiq Pay  
**Competition:** Nimiq Mini Apps Competition — Cycle III, Pay category  
**Status:** Brand locked; editable replacement derived from the supplied product concept PDF  
**Source truth:** The original PDF remains unchanged. This document separates evidence from target build scope.

> **Pay from what you have. They receive what they use.**

## 1. Executive thesis

### The product in one sentence

You have NIM. They do not use NIM. **Thence lets you pay them anyway.**

The sender chooses how to fund the payment; the recipient receives the supported asset and network they actually use.

Thence is a Nimiq Pay Mini App that turns cross-asset and cross-network payment routing into a normal, recipient-first transfer. A sender holds NIM. A recipient may want USDT on Polygon, USDC on Base or Arbitrum, or BTC over Lightning. The sender should not need to become a trader, bridge operator or gas manager to complete a simple payment.

### Core principle

> **Expose the payment intent. Hide the routing machinery.**

Thence is not a swap dashboard. It should never force ordinary users to reason about bridges, HTLCs, sats, CCTP or chain routing as the primary experience.

## 2. Problem

Crypto payments become difficult when the sender and recipient do not use the same asset or network.

### Asset mismatch

The sender holds NIM or another supported source asset, while the recipient specifically wants USDT, USDC or BTC.

### Network mismatch

“USDT” is not enough. The recipient may require Polygon, Arbitrum, Ethereum, Base or another supported network.

### Operational complexity

Users manually swap, bridge, select networks, manage gas and repeat steps simply to make one payment.

### Acceptance ceiling

NIM becomes less useful whenever the person being paid does not directly accept NIM.

### The user tension

> **Why do I have to become a trader just to make a payment?**

The recurring job is not to exchange assets for its own sake. It is to make sure a person or service receives a specific amount in a specific form.

## 3. User model: the payment contract

Every Thence transfer is defined by four facts. Everything else is infrastructure.

| Field | Meaning | Example |
|---|---|---|
| Who | Beneficiary or payee | Daniel |
| What they receive | Exact requested amount and asset | 50 USDC |
| Where they receive it | Supported settlement network and destination | Base — `[REDACTED]` |
| How the sender funds it | Payer’s source balance | NIM in Nimiq Pay |

The product starts with **Who are you paying?** rather than **What do you want to swap?** That is what makes it feel like a bank transfer instead of DeFi.

## 4. Experience thesis

The home experience should feel like a bank account, not a multi-asset trading terminal.

### Home should show

- The real NIM balance.
- An indicative “send value as” selector.
- Primary Send and secondary Request actions.
- Recent recipients.
- Recent and active activity.

The destination value on the home card is an estimate of what the current NIM balance could send as. It is not an owned USDT, USDC or BTC balance. The final NIM debit belongs to the native Nimiq Pay approval step.

## 5. Core navigation

Thence uses four primary surfaces:

1. **Home** — NIM balance, indicative send-as estimate, Send, Request, recent recipients and active transfers.
2. **Send** — beneficiary, exact receive amount, quote/review, Nimiq Pay approval and settlement status.
3. **Recipients** — saved beneficiary, preferred asset/network/destination, verification state, history and Pay Again.
4. **Activity** — pending, delivered, expired and needs-attention transfers with proof receipts.

Profile, settings, support and technical diagnostics remain behind the avatar/settings surface rather than consuming a primary tab.

## 6. Recipients are crypto beneficiaries

The beneficiary book removes repeated wallet-address and network decisions from repeat payments.

### Manual beneficiary

A payer saves the recipient name, preferred asset, network and destination from information the recipient shared.

### Verified beneficiary

The recipient proves control of the settlement destination by signing a verification challenge. Thence displays the verified state as an additional trust signal.

Verification is not required to send. A manual recipient is equivalent to a bank beneficiary saved from details the user received.

### Recipient detail

A recipient detail surface should show:

- Preferred settlement asset and network.
- Destination label and safe copy action.
- Verification state: added by payer or verified by recipient.
- Last paid and total transfers when available.
- Send money.
- Edit, archive or replace settlement preference.

## 7. Exact receive is the default

The payer enters the amount the recipient must receive. The sender does not calculate how much NIM that should equal.

Example:

> **Daniel receives 50.00 USDC.**

The route engine solves for the required Lightning amount or supported provider route. Nimiq Pay owns the final NIM debit confirmation.

### Flow

1. **Amount:** “Daniel receives 50 USDC.”
2. **Quote:** Thence checks the supported route, limits and fees.
3. **Approval:** Nimiq Pay shows the exact NIM debit before approval.
4. **Delivery:** Thence verifies that the destination-side amount and proof support a Delivered state.

### Why this matters

- The user’s obligation is expressed in recipient terms.
- Fees and route changes do not change the mental model.
- Pay Again remains simple because the recipient preference is stored.
- More settlement assets can be added without turning Thence into a trading interface.

## 8. Request to Pay

Recipients should be able to specify what they want and let the payer choose how to fund it.

### Request flow

1. Daniel creates a request for an amount, asset, network and destination.
2. He shares a link or QR.
3. Kaelah opens the request inside Nimiq Pay.
4. The request pre-fills the recipient and exact receive terms.
5. Kaelah pays with NIM.
6. Thence shows delivery and offers to save Daniel.

### Request object

A request may include:

- Recipient display name.
- Requested amount.
- Asset and network.
- Destination address or account reference.
- Optional memo or purpose.
- Expiration.
- Verification proof where available.

The product thesis is visible in one sentence:

> **The recipient chooses what they receive; the sender chooses what they pay with.**

## 9. Bank-style payment status

Users should not have to read protocol states as the primary UX.

| User-facing state | Meaning | Technical detail underneath |
|---|---|---|
| Payment approved | Nimiq Pay accepted the action | Lightning handoff returned identifiers |
| Converting | Cross-asset settlement is progressing | Client funded or provider processing |
| Sending | Destination-side liquidity or claim is progressing | Server funded or claim state |
| Delivered | Destination settlement is verifiably complete | EVM transaction or final swap state |
| Needs attention | Outcome is not safely classifiable yet | Timeout, unknown or recoverable state |
| Expired | Quote or invoice timed out before value moved | No value moved |

### Non-negotiable rule

> **Unknown is never treated as failed.**

The app must reconcile or resume before it allows a new payment attempt for the same transfer.

## 10. Receipts prove both sides

The receipt should communicate the product in one glance:

- What the sender paid in NIM.
- What the recipient received.
- The destination asset and network.
- The payment and route status.
- Safe proof identifiers where available.
- A Share Receipt action.

A receipt is not a claim that funds were delivered merely because a provider accepted a request. The Delivered state requires destination evidence appropriate to the route.

## 11. Supported settlement matrix

Thence should expose only routes that are live and quoteable at the time of use. A route registry enables or disables options dynamically.

| Destination | Target route | Product treatment |
|---|---|---|
| USDT — Polygon | NIM → Lightning → Satora → USDT Polygon | Primary launch route when live quote and settlement evidence are available |
| USDT — Arbitrum | NIM → Lightning → Satora → USDT Arbitrum | Enable after route validation |
| USDC — Arbitrum | NIM → Lightning → Satora → USDC Arbitrum | Enable after route validation |
| USDC — Ethereum | NIM → Lightning → Satora → USDC Ethereum | Show route minimums and fees clearly |
| USDC — Base | Satora route with CCTP leg where required | Enable only when the bridged route is quoteable and trackable |
| BTC — Lightning | NIM → Nimiq Pay Lightning | Direct Nimiq-native route when supported |

The supplied concept records quote-level evidence for several routes but no completed mainnet settlement. “Quoteable” and “delivered” remain separate claims.

## 12. Nimiq fit

Thence belongs in the **Pay** category because the user’s intent is paying a beneficiary. Cross-asset routing is the hidden mechanism that extends where NIM can go.

Nimiq tooling is essential to the proposed experience:

- Nimiq Pay Mini App environment.
- Nimiq provider and account context.
- NIM as the sender’s source balance.
- Native Nimiq Pay approval.
- `payLightningInvoice()` as the funding handoff.
- Nimiq Pay’s existing NIM-to-Lightning capability.

The product should not add a trading tab, portfolio P&L, yield/APY view, manual bridge controls or a large unsupported token matrix.

## 13. Differentiation

| Typical crypto tool | Thence |
|---|---|
| Starts from tokens and chains | Starts from a person or payment request |
| User chooses a swap or bridge route | Thence selects a supported route behind the intent |
| Source amount comes first | Recipient exact-receive amount comes first |
| Address is the whole relationship | Recipient stores preferences and payment history |
| Protocol status dominates | Bank-style lifecycle with technical proof underneath |
| Success means swap completed | Success means destination delivery is evidenced |

Thence deliberately does not add trading charts, portfolio P&L, yield, NFTs, leverage, manual bridges or dozens of unsupported combinations.

## 14. Product scope

The current target scope is:

- NIM balance card.
- Indicative send-as selector.
- Exact-receive Send flow.
- Saved recipients and payment preferences.
- Optional recipient verification.
- Request to Pay with share link and QR.
- Recent recipients and Pay Again.
- Network and address guard.
- Live route quoting.
- Recovery and resume.
- Bank-like Activity.
- Cross-chain receipts.
- Recipient-owned default asset/network/destination profile.

Each feature remains subject to the **Shipped / Target / Roadmap / Hypothesis** status model in the PRD.

## 15. Ecosystem value

### Extends NIM’s payment reach

Useful destinations are no longer limited to people who explicitly accept NIM.

### Exercises native Nimiq Pay capability

Lightning funding and native approval are visible and essential, not sponsor decoration.

### Creates repeat payment behaviour

Beneficiaries, requests and Pay Again make Thence useful beyond a one-time demo.

### Makes interoperability understandable

The product translates cross-network capability into a normal payment experience.

### Possible future revenue

A future production model could charge a small transparent routing or service fee per successful transfer, subject to legal and compliance review. The competition MVP should prioritise payment correctness and proof over monetisation.

## 16. Demo narrative

### Judge story

1. Daniel wants USDT on Polygon.
2. The sender only has NIM.
3. The sender chooses Daniel and enters the exact amount Daniel should receive.
4. Thence validates a supported route.
5. Nimiq Pay shows native approval from NIM.
6. Thence shows a bank-style progress state.
7. Destination evidence is shown only when real and available.
8. The receipt proves the relationship between NIM paid and recipient asset delivered.

### Best demonstration pair

- Primary: NIM → USDT Polygon, if the route is live, quoteable and safely verifiable.
- Secondary: NIM → BTC Lightning or NIM → USDC Arbitrum, to prove the abstraction is not a single-network trick.

## 17. Truth boundary

| Capability | Status in supplied evidence | Public treatment |
|---|---|---|
| Nimiq Mini App SDK available | Source-reported pass | May be described as a development dependency; verify current implementation |
| `payLightningInvoice()` exposed | Source-reported pass | Do not claim live app success until exercised in the current build |
| Satora live quote | Source-reported pass | Say quote-level evidence, not completed settlement |
| Several asset/network quotes | Source-reported pass | Show route-specific evidence and current availability |
| Arbitrary destination accepted by current API shape | Source-reported pass | Validate address/network handling in the product |
| Unfunded swap creation and reload resume | Pending source test | Target until no-money click test passes |
| Real mainnet NIM → stablecoin settlement | Not yet proven in source | Never claim as shipped before value moves and proof is captured |

## 18. North star

A normal user should be able to pay someone who does not use NIM without understanding the route used to get there.

Success means:

- The real NIM balance appears immediately.
- A recipient can be saved with a clear settlement preference.
- The user enters what the recipient should receive.
- Unsupported routes and amounts are blocked before payment.
- Nimiq Pay remains the approval boundary for NIM movement.
- Pending payments survive reload and cannot accidentally be paid twice.
- Success is shown only after destination delivery is verified.
- The receipt proves sender debit context, route identity and recipient settlement.
- The app feels like a bank transfer, not a bridge or exchange.

> **Pay from what you have. They receive what they use.**

## Sources

- Supplied source PDF: `/home/endy/.hermes/profiles/davinci/cache/documents/doc_d1e7b1e73459_NIM_Cross_Asset_Payments_Product_Idea.pdf`
- Supplied companion PRD/build-plan PDF: `/home/endy/.hermes/profiles/davinci/cache/documents/doc_834b644d283e_NIM_Cross_Asset_Payments_PRD_Build_Plan_Architecture.pdf`
- Nimiq Mini Apps Competition — Cycle III: https://miniappscompetition.com/cycle3
- Nimiq Mini Apps Competition — official rules: https://miniappscompetition.com/rules
- Nimiq Developer Center — Mini Apps: https://nimiq.dev/mini-apps
