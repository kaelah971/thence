/**
 * P7 E2E — per-test harness: the SIMULATED Nimiq Pay host and the routing of
 * the browser Satora SDK to the simulator. Clearly test adapters:
 *
 * - `window.nimiq` (injected before any page script, exactly where Nimiq Pay
 *   injects its provider): `sign` signs Thence's login challenge with the
 *   ephemeral E2E wallet (Node-side, via a binding — the key never enters the
 *   page); `payLightningInvoice` RECORDS the invoice and returns a simulated
 *   "submitted" result. No Lightning payment exists anywhere.
 * - https://api.satora.io/** is served by e2e/mock-services.ts. The REAL
 *   Satora SDK runs in the page, generating and storing the real preimage in
 *   the page's IndexedDB; only its HTTP peer is simulated.
 * - Every other external request is aborted, so nothing leaves the machine.
 */
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { buildSignPayload, deriveNimiqAddress, sha256 } from "../src/lib/nimiq";
import { APP_URL, MOCK_URL, RUN_DIR } from "./config";

interface Wallet {
  publicKeyHex: string;
  pkcs8Hex: string;
  address: string;
}

export function e2eWallet(): Wallet {
  return JSON.parse(readFileSync(join(RUN_DIR, "wallet.json"), "utf8")) as Wallet;
}

/** Addresses of every per-test wallet this run created (TEST database cleanup). */
export const E2E_WALLETS_FILE = "wallets.txt";

/**
 * A fresh ephemeral wallet per test (= a separate Thence user). Public mode
 * allows ONE unresolved payment per user, so specs must not share a payer;
 * this also matches real use (independent users). Test keys only; they
 * control no funds anywhere. Addresses are recorded for teardown.
 */
function freshWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const pkcs8Hex = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("hex");
  const address = deriveNimiqAddress(publicKeyHex);
  appendFileSync(join(RUN_DIR, E2E_WALLETS_FILE), `${address}\n`, "utf8");
  return { publicKeyHex, pkcs8Hex, address };
}

/** POST to the simulator's test-control API. */
export async function sim<T = Record<string, unknown>>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${MOCK_URL}/__e2e/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || json.error) throw new Error(`simulator ${action}: ${json.error ?? res.status}`);
  return json;
}

export interface SimState {
  latest: number;
  createdSwaps: number;
  unhandled: string[];
  requests: string[];
  swaps: Array<{ id: string; status: string; hashLock: string; secretsSeen: string[]; claims: Array<{ at: string; preimageMatches: boolean; executed: boolean }>; targetAddress: string; targetAmount: string; deadline: number }>;
}

/** The simulated host, injected before any Thence script runs. */
function hostScript(): void {
  const w = window as unknown as Record<string, unknown> & {
    __e2eHost: { payments: string[]; approveDelayMs: number; hideDuringApproval: boolean; mode: "approve" | "reject" | "hang" };
    __e2eSign: (message: string) => Promise<{ publicKey: string; signature: string }>;
  };
  w.__e2eHost = { payments: [], approveDelayMs: 800, hideDuringApproval: true, mode: "approve" };
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  (w as unknown as { __e2eSetHidden: (h: boolean) => void }).__e2eSetHidden = (h: boolean) => {
    hidden = h;
    document.dispatchEvent(new Event("visibilitychange"));
    if (!h) {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    }
  };
  w["nimiqPay"] = { network: "mainnet", language: "en", userFiat: "USD" };
  w["nimiq"] = {
    async sign(message: string) {
      return w.__e2eSign(message);
    },
    async getBalance() {
      return 100_000_000;
    },
    async listAccounts() {
      return [];
    },
    async payLightningInvoice(request: { invoice: string }) {
      w.__e2eHost.payments.push(request.invoice);
      if (w.__e2eHost.mode === "reject") throw Object.assign(new Error("User denied the request."), { type: "PERMISSION_DENIED", code: 4001 });
      if (w.__e2eHost.mode === "hang") return new Promise(() => undefined);
      // The Nimiq Pay sheet covers the mini app while the owner approves.
      if (w.__e2eHost.hideDuringApproval) (w as unknown as { __e2eSetHidden: (h: boolean) => void }).__e2eSetHidden(true);
      await new Promise((r) => setTimeout(r, w.__e2eHost.approveDelayMs));
      return { hash: `e2e-simulated-nimiq-tx-${w.__e2eHost.payments.length}`, swapId: `e2e-simulated-nimiq-swap-${w.__e2eHost.payments.length}` };
    },
  };
}

export async function prepareContext(context: BrowserContext): Promise<void> {
  const wallet = freshWallet();
  const key = createPrivateKey({ key: Buffer.from(wallet.pkcs8Hex, "hex"), format: "der", type: "pkcs8" });
  await context.exposeBinding("__e2eSign", (_source, message: string) => ({
    publicKey: wallet.publicKeyHex,
    signature: sign(null, sha256(buildSignPayload(message)), key).toString("hex"),
  }));
  await context.addInitScript(hostScript);
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)[^/]+\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "api.satora.io") {
      const postData = route.request().method() === "POST" ? route.request().postData() : null;
      const res = await fetch(`${MOCK_URL}/satora${url.pathname}${url.search}`, {
        method: route.request().method(),
        headers: { "content-type": "application/json" },
        ...(postData !== null ? { body: postData } : {}),
      });
      await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
      return;
    }
    await route.abort("blockedbyclient");
  });
}

/** Simulate leaving to / returning from the Nimiq Pay app (visibility + focus + pageshow). */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => (window as unknown as { __e2eSetHidden: (x: boolean) => void }).__e2eSetHidden(h), hidden);
}

export async function hostPayments(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __e2eHost: { payments: string[] } }).__e2eHost.payments);
}

export const test = base.extend<{ app: Page }>({
  app: async ({ context, page }, provide) => {
    await sim("reset");
    await prepareContext(context);
    await provide(page);
    const state = await sim<SimState>("state");
    // Nothing the app did should have fallen outside the simulated contracts.
    expect(state.unhandled, "unhandled simulated endpoints").toEqual([]);
  },
});

export { expect, APP_URL };
