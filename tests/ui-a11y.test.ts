/**
 * Slice 0 C1 — disabled swipe / tap fallback stays readable.
 * Guards CSS (no opacity fade on text) and token contrast (WCAG AA).
 * Touch targets: tap fallback >=44px, swipe track >=64px, handle >=44px.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWalletVerified } from "@/ui/lib/recipients-api";

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe("disabled action contrast (Slice 0 C1)", () => {
  it("keeps body text tokens at AA on paper", () => {
    // --text-2 #5a6562 on --paper #ffffff, --mist-100 #eff3f1
    expect(contrast("#5a6562", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#5a6562", "#eff3f1")).toBeGreaterThanOrEqual(4.5);
    // --text-3 is secondary only; disabled interactive text must not use it.
  });

  it("does not fade the tap fallback with opacity", () => {
    const css = readFileSync("src/ui/screens/send/send.module.css", "utf8");
    const block = css.slice(css.indexOf(".tapAlt:disabled"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).not.toMatch(/opacity\s*:\s*0\./);
    expect(rule).toMatch(/text-decoration\s*:\s*underline/);
    expect(rule).toMatch(/cursor\s*:\s*not-allowed/);
  });

  it("keeps the swipe label readable when disabled (no global track fade)", () => {
    const css = readFileSync("src/ui/components/swipe.module.css", "utf8");
    const idx = css.indexOf('.track[data-disabled="true"]');
    expect(idx).toBeGreaterThanOrEqual(0);
    const head = css.slice(idx, idx + 400);
    expect(head).not.toMatch(/opacity\s*:\s*0\.45/);
  });

describe("verified badge contrast and semantics (Slice 1 C6)", () => {
  it("keeps the verified text badge at AA on its mint background", () => {
    // --status-move #0b7a56 on --status-done-bg #dcf6e7 (was --status-done).
    expect(contrast("#0b7a56", "#dcf6e7")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the verified avatar dot at AA for white-on-green", () => {
    expect(contrast("#ffffff", "#0b7a56")).toBeGreaterThanOrEqual(4.5);
  });

  it("uses the darker verified green in every badge surface", () => {
    for (const file of [
      "src/ui/screens/recipients/recipients.module.css",
      "src/ui/screens/send/send.module.css",
    ]) {
      const css = readFileSync(file, "utf8");
      // The verified override keeps the mint background but uses the darker
      // AA-passing green for text (not the combined grey selector above it).
      expect(css, file).toMatch(
        /\.badgeOk\s*\{[^}]*background\s*:\s*var\(--status-done-bg\)[^}]*color\s*:\s*var\(--status-move\)/s,
      );
    }
    const primitives = readFileSync("src/ui/components/primitives.module.css", "utf8");
    const badge = primitives.indexOf(".avatarBadge");
    expect(badge).toBeGreaterThanOrEqual(0);
    expect(primitives.slice(badge, badge + 400)).toMatch(/background\s*:\s*var\(--status-move\)/);
  });

  it("shows verified only when the backend confirms it", () => {
    expect(isWalletVerified({ status: "verified-by-recipient", verifiedAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isWalletVerified({ status: "added-by-you" })).toBe(false);
    expect(isWalletVerified(null)).toBe(false);
    expect(isWalletVerified(undefined)).toBe(false);
  });

  it("never infers verification from an address being valid or saved", () => {
    // A well-formed saved address without backend confirmation stays unverified.
    expect(isWalletVerified({ status: "added-by-you" })).toBe(false);
  });
});

  it("preserves minimum touch targets", () => {
    const send = readFileSync("src/ui/screens/send/send.module.css", "utf8");
    const swipe = readFileSync("src/ui/components/swipe.module.css", "utf8");
    expect(send).toMatch(/\.tapAlt\s*\{[^}]*min-height\s*:\s*44px/);
    expect(swipe).toMatch(/\.track\s*\{[^}]*height\s*:\s*68px/);
    expect(swipe).toMatch(/\.handle\s*\{[^}]*width\s*:\s*56px/);
  });
});
