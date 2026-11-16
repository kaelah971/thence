# PR84 adversarial follow-up

Baseline `0770512`, 2026-11-16. Five deterministic regressions failed before
the correction: SDK success without acceptance, unanswered send followed by
rejected retry, wrong JSON-RPC response ID, Polygon already-in-progress success
without a transaction hash, and reverted receipt hidden by SDK success.

Corrections retain uncertainty across retries, require matching RPC IDs and
acceptance evidence, prioritize failed receipts, and refuse overlapping claim
observers before a second SDK invocation. SDK/provider free text is replaced
with fixed messages; stage and numeric error codes remain. Hex redaction alone
cannot guarantee secrecy for byte arrays or other encodings. Preflight failures
no longer consume the twelve durable execution-report slots.

These corrections do not prove sponsorship or delivery. No on-chain operation
does not rule out bundler acceptance followed by non-inclusion. The f1ca0926
browser exception remains unknown. Actual iOS Nimiq Pay webview behavior remains
unverified. No new canary, production change or financial operation occurred.

The broader audit found separate settlement-binding and browser-persistence
defects; follow-up work is tracked in `architecture/PAYMENT_AUDIT_CHECKPOINT.md`.
This narrow correction is not a complete payment-readiness verdict.
