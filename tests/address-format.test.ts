/**
 * Slice 1 C2 — wallet-address presentation.
 * Middle-truncation for display, exact values on clipboard, full value
 * available without breaking narrow layouts. Forms stay full-text editable
 * (verified by absence of AddressDisplay in form components).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { maskAddress } from "@/ui/lib/assets";
import { copyExactAddress } from "@/ui/components/AddressDisplay";

const ADDR = "0x4f2a9c1e7b3d8a0f6c5e2d1b9a8c7f6e5d4c3b21";

describe("address truncation (Slice 1 C2)", () => {
  it("middle-truncates long EVM addresses and leaves short values alone", () => {
    expect(maskAddress(ADDR)).toBe("0x4f2a…3b21");
    expect(maskAddress(ADDR).length).toBeLessThanOrEqual(12);
    expect(maskAddress("0x1234")).toBe("0x1234");
    expect(maskAddress("")).toBe("");
  });

  it("keeps the truncated form narrow enough for 360px layouts", () => {
    // 11 chars in monospace at 0.8125rem ≈ 75px — fits beside a copy button.
    expect(maskAddress(ADDR).length).toBe(11);
  });

  it("never wraps the truncated value; full value wraps only when expanded", () => {
    const css = readFileSync("src/ui/components/address.module.css", "utf8");
    const truncated = css.slice(css.indexOf(".truncated"));
    expect(truncated.slice(0, truncated.indexOf("}"))).toMatch(/white-space\s*:\s*nowrap/);
    expect(truncated.slice(0, truncated.indexOf("}"))).not.toMatch(/overflow-wrap\s*:\s*anywhere/);
    const full = css.slice(css.indexOf(".full"));
    expect(full).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(full).toMatch(/user-select\s*:\s*all/);
  });

  it("gives the toggle a 44px touch target", () => {
    const css = readFileSync("src/ui/components/address.module.css", "utf8");
    expect(css).toMatch(/\.toggle\s*\{[^}]*min-height\s*:\s*44px/);
  });
});

describe("address clipboard exactness (Slice 1 C2)", () => {
  it("copies the exact original address, never the truncated display value", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const ok = await copyExactAddress(ADDR);
      expect(ok).toBe(true);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(ADDR);
      expect(writeText).not.toHaveBeenCalledWith(maskAddress(ADDR));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports failure instead of throwing when the clipboard is unavailable", async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await expect(copyExactAddress(ADDR)).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("form inputs stay editable (Slice 1 C2)", () => {
  it("does not use the static display component inside editable forms", () => {
    const form = readFileSync("src/ui/components/DestinationForm.tsx", "utf8");
    expect(form).not.toMatch(/AddressDisplay/);
    const requestSteps = readFileSync("src/ui/screens/send/RequestSteps.tsx", "utf8");
    expect(requestSteps).not.toMatch(/AddressDisplay/);
    // Validation rules are preserved alongside the editable inputs.
    expect(form).toMatch(/destinationAddressIssue/);
    expect(requestSteps).toMatch(/destinationAddressIssue/);
  });
});
