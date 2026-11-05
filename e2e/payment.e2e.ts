/**
 * P7 — browser E2E of the full payment lifecycle through the REAL Thence UI,
 * the REAL production build, the REAL backend and the REAL browser Satora SDK
 * (preimage generated and stored in the page's IndexedDB), against the
 * anchor-proven TEST database.
 *
 * SIMULATED (and only these): the Nimiq Pay host (window.nimiq), Satora's
 * HTTP API and Polygon RPC — see e2e/mock-services.ts. These tests prove how
 * Thence behaves given those external behaviours; they do NOT prove the real
 * Nimiq Pay wallet, real Lightning, real Satora or real Polygon behave so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, hostPayments, setHidden, sim, test, type SimState } from "./harness";
import { approveInNimiqPay, clockOf, finishButton, latestSwap, prepareThirtyCents, returnToThence, signIn } from "./flows";
import { RUN_DIR } from "./config";
import type { Page, TestInfo } from "@playwright/test";

const DELIVERED_PROOF = () => /View on Polygon/;

async function swapState(id: string): Promise<SimState["swaps"][number]> {
  const st = await sim<SimState>("state");
  const s = st.swaps.find((x) => x.id === id);
  if (!s) throw new Error("swap missing");
  return s;
}

/** Approve in the simulated Nimiq Pay; funding lands while the owner is still away. */
async function approveAndFundWhileAway(page: Page): Promise<{ id: string; deadline: number }> {
  expect(await hostPayments(page)).toHaveLength(0); // nothing paid before the explicit confirm
  await approveInNimiqPay(page);
  await expect.poll(() => hostPayments(page)).toHaveLength(1);
  const swap = await latestSwap();
  // Owner is in Nimiq Pay (Thence hidden); Satora funds the Polygon HTLC meanwhile.
  await page.waitForTimeout(1_500);
  await sim("fund", { swapId: swap.id });
  await page.waitForTimeout(20_000); // hidden: the tracker must not poll, and must not give up
  return swap;
}

async function expectFinishWithDeadline(page: Page, deadline: number): Promise<void> {
  await expect(finishButton(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`Finish delivery before ${await clockOf(page, deadline)}`).first()).toBeVisible();
  await expect(page.getByText(/separate from Nimiq Pay's own timer/).first()).toBeVisible();
}

function serverLog(): string {
  try {
    return readFileSync(join(RUN_DIR, "server.log"), "utf8");
  } catch {
    return "";
  }
}

function only(testInfo: TestInfo, ...projects: string[]): void {
  test.skip(!projects.includes(testInfo.project.name), `runs on ${projects.join(", ")} only (runtime budget)`);
}

test.describe("payment lifecycle (simulated host/provider/chain)", () => {
  test.setTimeout(300_000);

  test("Nov 2 incident replay: away in Nimiq Pay while funded → back → Finish delivery before the deadline → verified USDC → Delivered", async ({ app }) => {
    const consoleLines: string[] = [];
    app.on("console", (m) => consoleLines.push(m.text()));
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    // Still away: no claim was made for the owner, and nothing says Delivered.
    expect((await swapState(swap.id)).claims).toHaveLength(0);

    await returnToThence(app);
    // The approval sheet no longer offers a second Nimiq Pay confirmation.
    await expect(app.getByRole("button", { name: "Confirm in Nimiq Pay" })).toHaveCount(0);
    await expect(app.getByText(/Don't pay again\./)).toBeVisible();
    // One status, one timeline: no static "after you approve" copy, no way back to review.
    await expect(app.getByText("What happens after you approve")).toHaveCount(0);
    await expect(app.getByRole("button", { name: "Back to review" })).toHaveCount(0);
    await expectFinishWithDeadline(app, swap.deadline);
    await expect(app.getByText(DELIVERED_PROOF())).toHaveCount(0);
    expect((await swapState(swap.id)).claims).toHaveLength(0); // never unattended

    await finishButton(app).first().click();
    await expect(app.getByText("Delivery submitted — verifying on Polygon").first()).toBeVisible({ timeout: 30_000 });
    const afterClaim = await swapState(swap.id);
    expect(afterClaim.claims).toHaveLength(1);
    expect(afterClaim.claims[0]!.preimageMatches).toBe(true); // the real SDK revealed THIS swap's secret
    await expect(finishButton(app)).toHaveCount(0);
    // Claimed is not delivered: no proof yet.
    await app.waitForTimeout(20_000);
    await expect(app.getByText(DELIVERED_PROOF())).toHaveCount(0);

    // Independently verifiable settlement evidence appears on (simulated) Polygon.
    await sim("settle", { swapId: swap.id });
    await expect(app.getByText(DELIVERED_PROOF())).toBeVisible({ timeout: 60_000 });
    await expect(app.getByText("Receipt", { exact: true }).first()).toBeVisible();
    await expect(app.getByText("0.3 USDC").first()).toBeVisible();

    // Exactly one host payment, one claim; no secret in the page, console or server log.
    expect(await hostPayments(app)).toHaveLength(1);
    const final = await swapState(swap.id);
    expect(final.claims).toHaveLength(1);
    const secret = final.secretsSeen[0]!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(consoleLines.join("\n").toLowerCase()).not.toContain(secret);
    expect((await app.content()).toLowerCase()).not.toContain(secret);
    expect(serverLog().toLowerCase()).not.toContain(secret);
    // No horizontal overflow at this viewport (mobile layouts included).
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test("Delivered only with the CORRECT USDC Transfer: a wrong-token receipt never delivers and is shown as needs attention", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await finishButton(app).first().click();
    await expect(app.getByText("Delivery submitted — verifying on Polygon").first()).toBeVisible({ timeout: 30_000 });
    // The claim tx is mined (once, immutably) crediting USDT instead of USDC.
    // (Short amounts and wrong recipients are covered against the real server
    // in tests/settlement.test.ts.)
    await sim("settle", { swapId: swap.id, token: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f" });
    await expect(app.getByText("The on-chain record doesn't match this payment").first()).toBeVisible({ timeout: 60_000 });
    await expect(app.getByText(DELIVERED_PROOF())).toHaveCount(0);
    await expect(app.getByText("Delivery submitted — verifying on Polygon")).toHaveCount(0);
  });

  test("refund is never shown as delivery: unclaimed swap refunded on Polygon → 'Not delivered — Polygon lock refunded'", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop", "webkit-iphone");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await sim("refund", { swapId: swap.id });
    await expect(app.getByText("Not delivered — Polygon lock refunded").first()).toBeVisible({ timeout: 60_000 });
    await expect(finishButton(app)).toHaveCount(0);
    await expect(app.getByText(DELIVERED_PROOF())).toHaveCount(0);
    await expect(app.getByText(/not a refund of your NIM/)).toBeVisible();
    expect((await swapState(swap.id)).claims).toHaveLength(0);
  });

  test("reload after funding keeps claim eligibility (IndexedDB recovery preserved) and finishes once", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop", "webkit-iphone");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await app.reload();
    await app.goto("/app/activity");
    await app.getByRole("button", { name: /Someone new|New recipient/ }).first().click();
    await expectFinishWithDeadline(app, swap.deadline);
    await finishButton(app).first().click();
    await expect(app.getByText("Delivery submitted — verifying on Polygon").first()).toBeVisible({ timeout: 30_000 });
    expect((await swapState(swap.id)).claims).toHaveLength(1);
    await app.reload();
    await app.goto("/app/activity");
    await app.getByRole("button", { name: /Someone new|New recipient/ }).first().click();
    await app.waitForTimeout(8_000);
    await expect(finishButton(app)).toHaveCount(0);
    expect((await swapState(swap.id)).claims).toHaveLength(1);
  });

  test("missing IndexedDB recovery material: Finish delivery refuses before anything is revealed", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    // The SDK's swap store is gone (cleared storage / different browser profile).
    await app.evaluate(async () => {
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(dbs.filter((d) => d.name && /lendaswap/i.test(d.name)).map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = () => r(null); })));
    });
    await finishButton(app).first().click();
    await expect(app.getByText(/couldn't be read back|doesn't match|deadline is too close or unavailable/).first()).toBeVisible({ timeout: 30_000 });
    expect((await swapState(swap.id)).claims).toHaveLength(0);
    expect((await sim<SimState>("state")).requests.filter((r) => r.includes("claim-gasless"))).toHaveLength(0);
  });

  test("duplicate taps and a second tab: exactly one claim reaches the provider", async ({ app, context }, testInfo) => {
    only(testInfo, "chromium-desktop", "webkit-iphone");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    const second = await context.newPage();
    await second.goto("/app/activity");
    await second.getByRole("button", { name: /Someone new|New recipient/ }).first().click();
    await expectFinishWithDeadline(second, swap.deadline);
    const a = finishButton(app).first();
    const b = finishButton(second).first();
    // Double tap on one page (the second may land on the now-disabled button) + a tap in the other tab.
    await Promise.all([a.click(), a.click({ timeout: 2_000 }).catch(() => undefined), b.click({ timeout: 10_000 }).catch(() => undefined)]);
    await app.waitForTimeout(15_000);
    const s = await swapState(swap.id);
    expect(s.claims.filter((c) => c.executed)).toHaveLength(1);
    expect(s.claims.length).toBeLessThanOrEqual(1);
  });

  test("offline while funding lands: back online, the tracker recovers and offers Finish delivery", async ({ app, context }, testInfo) => {
    only(testInfo, "chromium-desktop", "chromium-mobile");
    await signIn(app);
    await prepareThirtyCents(app);
    await approveInNimiqPay(app);
    await expect.poll(() => hostPayments(app)).toHaveLength(1);
    await returnToThence(app);
    await context.setOffline(true);
    const swap = await latestSwap();
    await sim("fund", { swapId: swap.id });
    await app.waitForTimeout(20_000);
    await expect(finishButton(app)).toHaveCount(0);
    await context.setOffline(false);
    await expectFinishWithDeadline(app, swap.deadline);
  });

  test("unknown claim outcome that DID land: no retry offered or accepted; delivery still verified", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop", "webkit-iphone");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await sim("claim-mode", { mode: "unknown-landed" });
    await finishButton(app).first().click();
    // Authoritative checkpoint: the simulated provider has received the claim
    // (generic "do not resend" copy is always on screen and proves nothing).
    await expect.poll(async () => (await swapState(swap.id)).claims.length, { timeout: 60_000 }).toBe(1);
    await expect(app.getByText(/couldn't be confirmed/i).first()).toBeVisible({ timeout: 30_000 });
    await app.waitForTimeout(45_000); // verification round runs; provider + chain show the claim
    await expect(finishButton(app)).toHaveCount(0);
    expect((await swapState(swap.id)).claims).toHaveLength(1);
    await sim("settle", { swapId: swap.id });
    await expect(app.getByText(DELIVERED_PROOF())).toBeVisible({ timeout: 60_000 });
    expect((await swapState(swap.id)).claims).toHaveLength(1);
  });

  test("unknown claim outcome that did NOT land: no retry inside the 10-minute pending horizon, even after the old 3-minute lease", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    test.setTimeout(600_000);
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await sim("claim-mode", { mode: "unknown-lost" });
    await finishButton(app).first().click();
    // Authoritative checkpoint: the simulated provider has received the claim
    // (generic "do not resend" copy is always on screen and proves nothing).
    await expect.poll(async () => (await swapState(swap.id)).claims.length, { timeout: 60_000 }).toBe(1);
    await expect(app.getByText(/couldn't be confirmed/i).first()).toBeVisible({ timeout: 30_000 });
    expect((await swapState(swap.id)).claims.filter((c) => c.executed)).toHaveLength(0);
    // The provider still says serverfunded and the HTLC is unspent — but a
    // relayed claim could still be pending, so for 10 minutes nothing retries.
    await sim("claim-mode", { mode: "ok" });
    for (const waitMs of [60_000, 150_000]) {
      await app.waitForTimeout(waitMs);
      const again = finishButton(app).first();
      if (await again.isVisible().catch(() => false)) {
        await again.click();
        await app.waitForTimeout(8_000);
      }
    }
    // 3.5 minutes after the unknown outcome: still exactly the one attempt.
    const s = await swapState(swap.id);
    expect(s.claims).toHaveLength(1);
    expect(s.claims.filter((c) => c.executed)).toHaveLength(0);
    // (The post-horizon retry — lease expired + provider clean + chain unspent —
    // is exercised against the real server in tests/p3-claim-intent.test.ts.)
  });

  test("deadline: inside the 5-minute unsafe window and after expiry there is no Finish delivery", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop", "webkit-iphone");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    // The page's clock only (server unchanged): 4 minutes before the deadline.
    await app.clock.setFixedTime(new Date((swap.deadline - 4 * 60) * 1000));
    await setHidden(app, true);
    await setHidden(app, false);
    await expect(app.getByText("Too close to the delivery deadline").first()).toBeVisible({ timeout: 30_000 });
    await expect(finishButton(app)).toHaveCount(0);
    await app.clock.setFixedTime(new Date((swap.deadline + 60) * 1000));
    await setHidden(app, true);
    await setHidden(app, false);
    await expect(app.getByText("The delivery deadline has passed").first()).toBeVisible({ timeout: 30_000 });
    await expect(finishButton(app)).toHaveCount(0);
    expect((await swapState(swap.id)).claims).toHaveLength(0);
  });

  test("Nimiq Pay rejection: nothing is paid, nothing funds, no claim", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    await signIn(app);
    await prepareThirtyCents(app);
    await app.evaluate(() => {
      (window as unknown as { __e2eHost: { mode: string; hideDuringApproval: boolean } }).__e2eHost.mode = "reject";
    });
    await approveInNimiqPay(app);
    await expect(app.getByText(/cancelled/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(finishButton(app)).toHaveCount(0);
    const st = await sim<SimState>("state");
    expect(st.swaps.every((s) => s.claims.length === 0)).toBe(true);
  });

  test("price moved between quote and swap: explicit re-confirmation is required before Nimiq Pay is asked", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    await sim("reprice", { sats: 1 });
    await signIn(app);
    await app.goto("/app/send");
    await app.getByPlaceholder("0x…").fill("0x7e57e2e5000000000000000000000000000000a1");
    await app.getByRole("button", { name: "Continue" }).click();
    const amount = app.getByRole("region", { name: "Amount" });
    for (const key of ["0", "Decimal point", "3", "0"]) await amount.getByRole("button", { name: key, exact: true }).click();
    await amount.getByRole("button", { name: "Review" }).click();
    await app.getByRole("button", { name: "Can't swipe? Continue with a tap" }).click();
    await expect(app.getByText("The price moved").first()).toBeVisible({ timeout: 60_000 });
    await expect(app.getByRole("button", { name: "Confirm in Nimiq Pay" })).toHaveCount(0);
    expect(await hostPayments(app)).toHaveLength(0);
  });

  test("provider identity drift after binding (deadline changed): the server refuses the claim; nothing is revealed", async ({ app }, testInfo) => {
    only(testInfo, "chromium-desktop");
    await signIn(app);
    await prepareThirtyCents(app);
    const swap = await approveAndFundWhileAway(app);
    await returnToThence(app);
    await expectFinishWithDeadline(app, swap.deadline);
    await sim("drift", { swapId: swap.id, deadlineDeltaSeconds: 600 });
    await finishButton(app).first().click();
    await app.waitForTimeout(10_000);
    expect((await swapState(swap.id)).claims).toHaveLength(0);
    await expect(app.getByText(/Do not continue|doesn't match/).first()).toBeVisible();
  });
});
