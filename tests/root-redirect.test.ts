/**
 * F5.3 homepage routing regression guard.
 * The root route must server-redirect to /app (the real Thence interface)
 * and must not resurrect the old B0 backend placeholder.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT_PAGE = readFileSync(join(__dirname, "..", "app", "page.tsx"), "utf8");

describe("root homepage routing (F5.3)", () => {
  it("redirects / to /app via next/navigation", () => {
    expect(ROOT_PAGE).toMatch(/from\s+["']next\/navigation["']/);
    expect(ROOT_PAGE).toMatch(/redirect\(\s*["']\/app["']\s*\)/);
  });

  it("no longer renders the B0 backend placeholder", () => {
    expect(ROOT_PAGE).not.toMatch(/Backend foundation/);
    expect(ROOT_PAGE).not.toMatch(/api\/health for service status/);
    expect(ROOT_PAGE).not.toMatch(/<h1>Thence<\/h1>/);
  });
});
