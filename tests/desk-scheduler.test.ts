import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const { tick } = createRequire(import.meta.url)("../ops/selfhost/thence-desk-worker.cjs") as { tick: (input: { credentialDirectory: string; fetcher: typeof fetch; log: (line: string) => void }) => Promise<unknown> };
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    const target = realpathSync(path);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("thence-worker-test-")) throw new Error("Unexpected test directory");
    rmSync(target, { recursive: true });
  }
});
function credential() {
  const path = mkdtempSync(join(tmpdir(), "thence-worker-test-")); directories.push(path);
  writeFileSync(join(path, "cron-secret"), "test-credential-".repeat(3)); return path;
}
describe("production treasury scheduler", () => {
  it("uses loopback authorization and logs counters only", async () => {
    const log = vi.fn();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ checked: 1, delivered: 0, refundDue: 0, errors: 0, ambiguous: 0, secret: "must-not-log" }));
    await tick({ credentialDirectory: credential(), fetcher, log });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3200/api/cron/desk");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/credential|must-not-log/);
    expect(log.mock.calls[0]?.[0]).toContain('"checked":1');
  });
  it("refuses failed or malformed endpoint responses", async () => {
    const log = vi.fn(), path = credential();
    await expect(tick({ credentialDirectory: path, fetcher: async () => new Response("secret error", { status: 503 }), log })).rejects.toThrow();
    await expect(tick({ credentialDirectory: path, fetcher: async () => Response.json({ checked: "1" }), log })).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
