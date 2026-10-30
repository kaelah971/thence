/**
 * Slice 0 C3 — public request CTA stays in the first viewport.
 * Locks: sticky pay area, compact short-screen hero, expired never payable.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canPayRequest, type ApiPublicRequest } from "@/ui/lib/requests-api";

const req = (over: Partial<ApiPublicRequest> = {}): ApiPublicRequest => ({
  publicId: "AbCdEfGhIjKlMnOpQrStUv",
  recipientName: "Amara Obi",
  amount: "40.00",
  amountAtomic: "40000000",
  asset: "USDC",
  network: "Polygon",
  destination: "0x9a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c",
  memo: "Dinner on Friday",
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  status: "active",
  route: { id: "usdc-polygon", supported: true, quoteable: true },
  url: "/r/AbCdEfGhIjKlMnOpQrStUv",
  ...over,
});

describe("public request CTA (Slice 0 C3)", () => {
  it("keeps the pay area sticky above the safe area", () => {
    const css = readFileSync("src/ui/screens/requests/requests.module.css", "utf8");
    const idx = css.indexOf(".payArea");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = css.slice(idx, idx + 600);
    expect(block).toMatch(/position\s*:\s*sticky/);
    expect(block).toMatch(/bottom\s*:\s*calc\(var\(--safe-bottom\)/);
  });

  it("compacts the hero on short screens without changing tall screens", () => {
    const css = readFileSync("src/ui/screens/requests/requests.module.css", "utf8");
    expect(css).toMatch(/@media\s*\(max-height:\s*750px\)/);
    expect(css).toMatch(/\.publicAmount/);
  });

  it("never lets expired or cancelled requests be paid", () => {
    expect(canPayRequest(req({ status: "active" }))).toBe(true);
    expect(canPayRequest(req({ status: "expired" }))).toBe(false);
    expect(canPayRequest(req({ status: "cancelled" }))).toBe(false);
    // Unpayable route also never shows a payable CTA.
    expect(
      canPayRequest(req({ route: { id: "usdc-base", supported: true, quoteable: false } })),
    ).toBe(false);
  });
});
