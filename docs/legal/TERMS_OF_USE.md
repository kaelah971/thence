# Thence Terms of Use

> **DRAFT — not legal advice and not reviewed by a lawyer.** Prepared on 2026-11-06 from the
> code at `main`. Placeholders in `[brackets]` must be completed, and counsel must review the
> document before it is published. In particular, counsel must assess whether operating Thence
> creates money-transmission, payment-services, sanctions or KYC/AML obligations in the
> operator's or users' jurisdictions.

**Last updated:** [DATE OF PUBLICATION]

These Terms are an agreement between you and [LEGAL NAME OF OPERATOR] ("Thence", "we") for your
use of the Thence Mini App and website (the "Service"). By using the Service you agree to them.

## 1. What Thence does

Thence helps you send a stablecoin (currently **USDC on the Polygon network**) to a wallet
address you choose, paid with **NIM** from your Nimiq Pay wallet.

1. You enter the amount the recipient should receive. We show a live quote, priced in Lightning
   satoshis, that includes the provider's fees.
2. You approve the payment. **Nimiq Pay**, not Thence, pays the Lightning invoice from your NIM.
   Nimiq Pay shows you the NIM amount before you confirm.
3. An independent swap provider (**Satora**) locks the stablecoin for the recipient in an
   on-chain contract.
4. You tap **Finish delivery** in the app, which releases the stablecoin to the recipient.

## 2. Thence is non-custodial

- Thence never holds, receives or controls your NIM, the swapped funds or the stablecoins.
- The keys needed to finish or recover a payment are created and stored **on your device**.
- We can't reverse, cancel, redirect or recover a payment for you.

## 3. Eligibility

You must:

- be at least 18 and able to enter a binding contract;
- not be located in, or a resident or national of, a sanctioned or embargoed country or region;
- not be on any sanctions list;
- not be prohibited by applicable law from using the Service.

[COUNSEL: add restricted jurisdictions.]

## 4. Your responsibilities

- **Check the recipient address and network.** Payments to a wrong, unsupported or
  inaccessible address can't be recovered.
- **Finish delivery in time.** Each payment has a claim deadline (currently about one hour after
  approval). Stay in Nimiq Pay and keep the app's data until delivery shows as complete. If you
  miss the deadline, the provider's refund process is designed to return the NIM. Timing depends
  on the Lightning and Nimiq Pay timeouts.
- **Keep your device data.** Clearing app data, uninstalling or losing your device during a
  payment can make it impossible to finish delivery. A refund is then the expected outcome.
- **Keep your wallet secure.** You are responsible for your Nimiq Pay wallet and device.
- **Comply with law,** including tax reporting for your payments.

## 5. Quotes, amounts and fees

- Quotes expire, normally within minutes. If a quote expires, you must requote.
- The amount the recipient receives is fixed by the quote. The recipient may receive slightly
  **more** than the quoted amount because of provider rounding, but never knowingly less.
- The swap provider's fees and network fees are included in the Lightning amount. Nimiq Pay may
  apply its own fees or exchange rate when converting NIM. [OPERATOR: state whether Thence
  charges any fee; it currently charges none.]
- Providers set minimum and maximum amounts, and they may change.

## 6. Delivery and status

The Service shows a payment as **Delivered** only after it has verified, on the blockchain, that
the token transfer to the recipient reached the required confirmations. Until then, a payment
may show as in progress. "Refunded" or "Needs attention" mean the payment was not delivered.

## 7. Availability, pauses and limits

- The Service is offered as an **early-access / beta** service.
- We may enable, pause or limit payments, routes or amounts at any time and without notice, for
  safety, legal or operational reasons. This includes an emergency switch that stops new
  payments.
- Pausing never prevents finishing or recovering a payment that is already in progress.
- Only some assets and networks are supported. Others shown in the app may be unavailable.

## 8. Third-party services

The Service depends on services we don't control:

- Nimiq Pay and the Nimiq network;
- the Lightning Network;
- the swap provider (Satora) and its contracts;
- blockchain networks, blockchain data providers and hosting providers.

Their terms apply to your use of them. We aren't responsible for their availability, fees,
errors or conduct.

## 9. Prohibited use

Don't use the Service:

- for unlawful activity, including fraud, money laundering, terrorist financing or sanctions
  evasion;
- to attack, overload, probe or reverse-engineer the Service's security;
- to evade rate limits;
- to infringe others' rights.

We may refuse or restrict access if we suspect prohibited use.

## 10. No advice

Thence doesn't provide financial, investment, tax or legal advice. Digital assets are volatile
and risky. Stablecoins can lose their peg.

## 11. Open-source software

Thence's source code is licensed under the MIT License. That license covers the code. These
Terms cover your use of the hosted Service.

## 12. Disclaimers

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, TO THE
FULLEST EXTENT PERMITTED BY LAW. [COUNSEL: adapt to mandatory consumer law.]

## 13. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY LAW, THENCE IS NOT LIABLE FOR:

- INDIRECT, INCIDENTAL OR CONSEQUENTIAL DAMAGES;
- LOSS OF FUNDS CAUSED BY INCORRECT ADDRESSES, LOST DEVICE DATA OR THIRD-PARTY FAILURES;
- AMOUNTS ABOVE [CAP].

[COUNSEL: review.]

## 14. Changes and termination

We may update these Terms. If a change is material, we will tell users in the app. You may stop
using the Service at any time. We may suspend access for breach of these Terms.

## 15. Governing law

[JURISDICTION / DISPUTE RESOLUTION — COUNSEL]

## 16. Contact

[EMAIL / ADDRESS]
