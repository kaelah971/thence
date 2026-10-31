/**
 * F8.2 — database kill-switch unit tests (pure: no DB, no network).
 *
 * Corrects the F8 preflight assumption that a Vercel env change is an
 * instantaneous switch (it is not — it needs a redeploy). New funded
 * execution requires BOTH the deployed env gate (KEY 1) AND the database
 * switch (KEY 2, `pilot_controls.enabled`). Either key stops new funding
 * alone; recovery never reads the switch.
 *
 * - The DB gate no-ops for unconfigured / disarmed envs without touching
 *   the database, passes when armed + enabled, and fails closed
 *   (PILOT_DISABLED) when the row is missing/false or the read errors.
 *
 * The LIVE section of F8.2 (armed env + disabled DB blocks creates;
 * stop-after-funding blocks requote/prepare while recovery answers;
 * missing row fail-closed) runs inside
 * tests/f81-pilot-attempt-limits.test.ts ON PURPOSE: both suites mutate
 * the single shared `pilot_controls` row, so they must run sequentially
 * in one file (vitest parallelizes across files).
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "@/lib/auth";
import {
  assertPilotDbEnabled,
  getPilotConfig,
  isPilotDbEnabled,
} from "@/lib/pilot";

const OWNER = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

function armedEnv(): Record<string, string | undefined> {
  return {
    THENCE_PILOT_ENABLED: "1",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
  };
}

/** Chainable stub for the kill-switch SELECT (no database). */
function stubDb(rows: Array<{ enabled: boolean }> | Error): { select: () => unknown } {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (rows instanceof Error) throw rows;
            return rows;
          },
        }),
      }),
    }),
  };
}

function throwingDb(): { select: () => unknown } {
  return {
    select: () => {
      throw new Error("database must not be touched");
    },
  };
}

describe("F8.2 database kill switch (pure, no DB)", () => {
  it("no-ops for unconfigured envs without touching the database", async () => {
    const config = getPilotConfig({});
    expect(config.owners).toEqual([]);
    await expect(assertPilotDbEnabled(config, throwingDb() as never)).resolves.toBeUndefined();
    await expect(isPilotDbEnabled(config, throwingDb() as never)).resolves.toBe(false);
  });

  it("no-ops for disarmed envs without touching the database", async () => {
    const config = getPilotConfig({
      THENCE_PILOT_ENABLED: "0",
      THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
    });
    await expect(assertPilotDbEnabled(config, throwingDb() as never)).resolves.toBeUndefined();
    await expect(isPilotDbEnabled(config, throwingDb() as never)).resolves.toBe(false);
  });

  it("passes when armed and the database switch is enabled", async () => {
    const config = getPilotConfig(armedEnv());
    await expect(isPilotDbEnabled(config, stubDb([{ enabled: true }]) as never)).resolves.toBe(true);
    await expect(assertPilotDbEnabled(config, stubDb([{ enabled: true }]) as never)).resolves.toBeUndefined();
  });

  it("fails closed when the row is missing, disabled, or unreadable", async () => {
    const config = getPilotConfig(armedEnv());
    await expect(isPilotDbEnabled(config, stubDb([]) as never)).resolves.toBe(false);
    await expect(isPilotDbEnabled(config, stubDb([{ enabled: false }]) as never)).resolves.toBe(false);
    await expect(isPilotDbEnabled(config, stubDb(new Error("conn refused")) as never)).resolves.toBe(false);
    await expect(assertPilotDbEnabled(config, stubDb([]) as never)).rejects.toMatchObject({
      code: "PILOT_DISABLED",
    });
    await expect(assertPilotDbEnabled(config, stubDb([{ enabled: false }]) as never)).rejects.toMatchObject({
      code: "PILOT_DISABLED",
    });
    await expect(assertPilotDbEnabled(config, stubDb(new Error("conn refused")) as never)).rejects.toMatchObject({
      code: "PILOT_DISABLED",
    });
    expect(AuthError).toBeDefined();
  });
});
