/**
 * Mobile payment UX — screenshot walk-through (simulated host/provider/chain).
 *
 * Captures every customer-visible payment state on WebKit (iPhone) at the
 * device viewport AND a tall viewport (whole sheet), into
 * e2e/.run/shots/<SHOTS_LABEL>/<viewport>/NN-state.png, so before/after can be
 * compared by a human. Assertions here are deliberately minimal and
 * label-tolerant; behavioural guarantees live in payment.e2e.ts and
 * payment-ux.e2e.ts.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, hostPayments, setHidden, sim, test, type SimState } from "./harness";
import { RECIPIENT, approveInNimiqPay, finishButton, latestSwap, signIn } from "./flows";
import { RUN_DIR } from "./config";
import type { Page, TestInfo } from "@playwright/test";

const LABEL = process.env["SHOTS_LABEL"] ?? "current";
const WIDTHS = [390, 360] as const;

async function shot(page: Page, width: number, name: string): Promise<void> {
  const dir = join(RUN_DIR, "shots", LABEL, String(width));
  mkdirSync(dir, { recursive: true });
  const height = width === 360 ? 740 : 844;
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}.png`) });
  // Tall capture: everything inside the sheet without inner scrolling.
  await page.setViewportSize({ width, height: 2200 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}-tall.png`) });
  await page.setViewportSize({ width, height });
}

function onlyIphone(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== "webkit-iphone", "screenshots on WebKit iPhone only");
}

for (const width of WIDTHS) {
  test(`UX walk-through screenshots @${width}`, async ({ app }, testInfo) => {
    onlyIphone(testInfo);
    test.setTimeout(300_000);
    await app.setViewportSize({ width, height: width === 360 ? 740 : 844 });
    await signIn(app);

    // 01 — Send entry with a valid wallet typed (CTA must be visible).
    await app.goto("/app/send");
    await app.getByPlaceholder("0x…").fill(RECIPIENT);
    await expect(app.getByText(/valid Polygon address/)).toBeVisible();
    await shot(app, width, "01-send-entry-valid");
    // Keyboard-up approximation: the iOS viewport resizes with the keyboard.
    await app.setViewportSize({ width, height: 420 });
    await app.getByPlaceholder("0x…").focus();
    await app.waitForTimeout(400);
    mkdirSync(join(RUN_DIR, "shots", LABEL, String(width)), { recursive: true });
    await app.screenshot({ path: join(RUN_DIR, "shots", LABEL, String(width), "02-send-entry-keyboard.png") });
    await app.setViewportSize({ width, height: width === 360 ? 740 : 844 });
    await app.getByRole("button", { name: /^(Continue|Review payment)$/ }).first().click();

    // 03 — Amount 0.30.
    const amount = app.getByRole("region", { name: "Amount" });
    for (const key of ["0", "Decimal point", "3", "0"]) await amount.getByRole("button", { name: key, exact: true }).click();
    await shot(app, width, "03-amount");
    await amount.getByRole("button", { name: /^Review/ }).click();

    // 04 — Review.
    await expect(app.getByText(/Live price · valid for/)).toBeVisible();
    await shot(app, width, "04-review");
    await app.getByRole("button", { name: "Can't swipe? Continue with a tap" }).click();

    // 05 — Ready for Nimiq Pay approval.
    await expect(app.getByRole("button", { name: "Confirm in Nimiq Pay" })).toBeVisible({ timeout: 60_000 });
    await shot(app, width, "05-ready-for-approval");

    // 06 — Approved, waiting for funding (back in Thence before funding lands).
    await approveInNimiqPay(app);
    await expect.poll(() => hostPayments(app)).toHaveLength(1);
    await app.waitForTimeout(1_500);
    await setHidden(app, false);
    await app.waitForTimeout(3_000);
    await shot(app, width, "06-approved-waiting-funding");

    // 07 — Funded: action required (Finish delivery).
    const swap = await latestSwap();
    await sim("fund", { swapId: swap.id });
    await expect(finishButton(app).first()).toBeVisible({ timeout: 45_000 });
    await shot(app, width, "07-funded-finish-delivery");

    // 08 — Claim submitted (not yet mined).
    await finishButton(app).first().click();
    await expect(finishButton(app)).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await sim<SimState>("state")).swaps.find((s) => s.id === swap.id)?.claims.length ?? 0, { timeout: 30_000 })
      .toBe(1);
    await app.waitForTimeout(3_000);
    await shot(app, width, "08-claim-submitted");

    // 09 — Mined but below finality (the 2026-11-05 10:34 state).
    await sim("settle", { swapId: swap.id, confirmations: 10 });
    await app.waitForTimeout(20_000);
    await shot(app, width, "09-finality-pending");

    // 10 — Activity while finality is pending. "Done" must lead to Activity
    // (after approval); older builds reset to the Send entry instead, so fall
    // back to the tab URL to keep the before/after walk comparable.
    await app.getByRole("button", { name: "Done", exact: true }).click();
    await app.waitForTimeout(2_000);
    if (!/\/app\/activity/.test(app.url())) await app.goto("/app/activity");
    await app.waitForTimeout(3_000);
    await shot(app, width, "10-activity-pending");
    const row = app.getByRole("button", { name: /0\.3|USDC/ }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await app.waitForTimeout(3_000);
      await shot(app, width, "11-activity-detail-pending");
    }

    // 12 — Finality reached → verified → Delivered with receipt.
    await sim("advance", { blocks: 300 });
    await expect(app.getByText(/View on Polygon/).first()).toBeVisible({ timeout: 90_000 });
    await shot(app, width, "12-delivered");
  });
}
