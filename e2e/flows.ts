/**
 * P7 E2E — user flows through the REAL Thence UI (no internal shortcuts):
 * every step is a click, tap or keystroke a person would make.
 */
import { expect, type Page } from "@playwright/test";
import { setHidden, sim } from "./harness";

/** A recipient Polygon address used only in the simulation. */
export const RECIPIENT = "0x7e57e2e5000000000000000000000000000000a1";

/** Open Thence and authenticate with the simulated Nimiq Pay host (handles first-run and returning owners). */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  for (let i = 0; i < 12; i++) {
    if (/\/app\/(home|send|activity|recipients)/.test(page.url())) break;
    const skip = page.getByRole("button", { name: "Skip" });
    const name = page.locator("#setup-name");
    const connect = page.getByRole("button", { name: "Continue with Nimiq Pay" });
    if (await connect.isVisible().catch(() => false)) {
      await connect.click();
      await page.waitForURL(/\/app\/(home|send|activity)/, { timeout: 30_000 });
      break;
    }
    if (await name.isVisible().catch(() => false)) {
      await name.fill("E2E Owner");
      await page.getByRole("button", { name: "Continue" }).click();
    } else if (await skip.isVisible().catch(() => false)) {
      await skip.click();
    }
    await page.waitForTimeout(700);
  }
  await expect(page).toHaveURL(/\/app\/(home|send|activity|recipients)/);
}

/** Recipient → 0.30 USDC → review → continue → prepared, ready for Nimiq Pay. */
export async function prepareThirtyCents(page: Page): Promise<void> {
  await page.goto("/app/send");
  await page.getByPlaceholder("0x…").fill(RECIPIENT);
  await expect(page.getByText("Looks like a valid Polygon address")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const amount = page.getByRole("region", { name: "Amount" });
  for (const key of ["0", "Decimal point", "3", "0"]) await amount.getByRole("button", { name: key, exact: true }).click();
  await expect(amount.getByRole("status")).toContainText("0.3");
  await amount.getByRole("button", { name: "Review" }).click();
  // Review: exact amount, network, wallet and a live (simulated) price.
  await expect(page.getByRole("heading", { name: "Review payment" })).toBeVisible();
  await expect(page.getByText("0.30", { exact: true })).toBeVisible();
  await expect(page.getByText("on Polygon").first()).toBeVisible();
  await expect(page.getByText(/Live price · valid for/)).toBeVisible();
  await expect(page.getByText("0x7e57…00a1")).toBeVisible();
  await page.getByRole("button", { name: "Can't swipe? Continue with a tap" }).click();
  await expect(page.getByRole("button", { name: "Confirm in Nimiq Pay" })).toBeVisible({ timeout: 60_000 });
}

/** The swap the real browser SDK created in this test. */
export async function latestSwap(): Promise<{ id: string; deadline: number; hashLock: string }> {
  const s = await sim<{ id: string | null; deadline: number; hashLock: string }>("latest-swap");
  if (!s.id) throw new Error("no swap created");
  return s as { id: string; deadline: number; hashLock: string };
}

/** Confirm in (simulated) Nimiq Pay: the host sheet covers Thence while approving. */
export async function approveInNimiqPay(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Confirm in Nimiq Pay" }).click();
}

/** Back from Nimiq Pay (or any other app). */
export async function returnToThence(page: Page): Promise<void> {
  await setHidden(page, false);
}

/** The deadline as Thence formats it (same locale/time zone as the page). */
export async function clockOf(page: Page, unixSeconds: number): Promise<string> {
  return page.evaluate((s) => new Date(s * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), unixSeconds);
}

export function finishButton(page: Page) {
  return page.getByRole("button", { name: "Finish delivery", exact: true });
}
