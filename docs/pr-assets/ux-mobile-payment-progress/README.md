# PR #37 evidence — mobile payment UX before/after

Composites for review only. **Simulated data**: E2E test wallet, test recipient
`0x7e57…00a1`, simulated Nimiq Pay host / Satora / Polygon (see e2e/README.md).
No real wallet, session, address or secret appears.

- BEFORE: `9a455cd` (production), WebKit iPhone 14 emulation, local run.
- AFTER: this PR, captured by CI (`staging-build` → `e2e` → artifact `ux-screens`).
- Widths: 390 px and 360 px viewports.
- Route availability labels on the Send entry differ by run timing, not by this change.
- The old build could not reach Activity from the payment sheet, so Activity /
  Delivered are AFTER-only.

This folder is PR evidence; it can be dropped before merge.
