/**
 * Build identity for on-device verification (pure, no DOM).
 *
 * The account sheet shows which release the app was built from so a phone
 * can prove it runs the current deployment (no more guessing from
 * dashboards). Value comes from the build environment; anything blank or
 * missing reads as "local".
 */
import { describe, expect, it } from "vitest";
import { buildId } from "@/ui/lib/build";

describe("buildId", () => {
  it("falls back to local when unset or blank", () => {
    expect(buildId({})).toBe("local");
    expect(buildId({ NEXT_PUBLIC_THENCE_BUILD_REF: "" })).toBe("local");
    expect(buildId({ NEXT_PUBLIC_THENCE_BUILD_REF: "   " })).toBe("local");
  });

  it("passes through the short commit sha", () => {
    expect(buildId({ NEXT_PUBLIC_THENCE_BUILD_REF: "abc1234" })).toBe("abc1234");
    expect(buildId({ NEXT_PUBLIC_THENCE_BUILD_REF: "  abc1234\n" })).toBe("abc1234");
  });
});
