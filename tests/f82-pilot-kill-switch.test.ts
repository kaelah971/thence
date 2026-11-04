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
  assertPilotBudget,
  assertPilotDbEnabled,
  assertPilotIntent,
  getPilotConfig,
  isPilotDbEnabled,
  pilotPaymentAvailability,
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

describe("F8.3 production-mandatory allowlist (pure, no DB)", () => {
  const prodBase = { NODE_ENV: "production" };

  it("production with a missing allowlist fails closed on every gate", async () => {
    // Disarmed production without allowlist: the legacy skip must NOT apply.
    const disarmed = getPilotConfig({ ...prodBase, THENCE_PILOT_ENABLED: "0" });
    expect(disarmed.production).toBe(true);
    expect(disarmed.owners).toEqual([]);
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, disarmed),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
    // Null (signed-out) owner is blocked too — never a silent pass.
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: null }, disarmed),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
    // Budget and database gates fail closed without touching the database.
    await expect(assertPilotBudget("user-1", "300000", disarmed, throwingDb() as never)).rejects.toMatchObject({
      code: "PILOT_NOT_AUTHORIZED",
    });
    await expect(assertPilotDbEnabled(disarmed, throwingDb() as never)).rejects.toMatchObject({
      code: "PILOT_NOT_AUTHORIZED",
    });
    await expect(isPilotDbEnabled(disarmed, throwingDb() as never)).resolves.toBe(false);
  });

  it("production armed without allowlist stays misconfigured fail-closed", async () => {
    const armed = getPilotConfig({ ...prodBase, THENCE_PILOT_ENABLED: "1" });
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, armed),
    ).toThrowError(expect.objectContaining({ code: "PILOT_NOT_AUTHORIZED" }));
    await expect(assertPilotBudget("user-1", "300000", armed, throwingDb() as never)).rejects.toMatchObject({
      code: "PILOT_NOT_AUTHORIZED",
    });
    await expect(assertPilotDbEnabled(armed, throwingDb() as never)).rejects.toMatchObject({
      code: "PILOT_NOT_AUTHORIZED",
    });
  });

  it("non-production keeps the legacy not-configured skip (dev/test/CI flows)", async () => {
    const dev = getPilotConfig({ NODE_ENV: "development" });
    expect(dev.production).toBe(false);
    expect(() =>
      assertPilotIntent({ routeId: "usdc-arbitrum", targetAmountAtomic: "999", ownerAddress: null }, dev),
    ).not.toThrow();
    await expect(assertPilotBudget("user-1", "300000", dev, throwingDb() as never)).resolves.toBeUndefined();
    await expect(assertPilotDbEnabled(dev, throwingDb() as never)).resolves.toBeUndefined();
    const unset = getPilotConfig({});
    expect(unset.production).toBe(false);
    expect(() =>
      assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: null }, unset),
    ).not.toThrow();
  });
});

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

describe("advisory payment availability (GET /api/pilot/status helper, pure)", () => {
  it("is 'available' only when KEY 1 (env + allowlist) and KEY 2 (database) both allow", async () => {
    const config = getPilotConfig(armedEnv());
    await expect(pilotPaymentAvailability(OWNER, config, stubDb([{ enabled: true }]) as never)).resolves.toBe("available");
  });

  it("is 'paused' when the database switch is off, missing or unreadable (fail-closed)", async () => {
    const config = getPilotConfig(armedEnv());
    for (const db of [stubDb([{ enabled: false }]), stubDb([]), stubDb(new Error("conn refused"))]) {
      await expect(pilotPaymentAvailability(OWNER, config, db as never)).resolves.toBe("paused");
    }
  });

  it("is 'paused' when the env key is off, the owner is not allowlisted, or production lacks an allowlist", async () => {
    const disarmed = getPilotConfig({ ...armedEnv(), THENCE_PILOT_ENABLED: "0" });
    await expect(pilotPaymentAvailability(OWNER, disarmed, throwingDb() as never)).resolves.toBe("paused");
    const armed = getPilotConfig(armedEnv());
    await expect(pilotPaymentAvailability("NQ52 1111 1111 1111 1111 1111 1111 1111 1111", armed, throwingDb() as never)).resolves.toBe("paused");
    await expect(pilotPaymentAvailability(null, armed, throwingDb() as never)).resolves.toBe("paused");
    const prodNoAllowlist = getPilotConfig({ NODE_ENV: "production", VERCEL_ENV: "production", THENCE_PILOT_ENABLED: "0" });
    expect(prodNoAllowlist.production).toBe(true);
    await expect(pilotPaymentAvailability(OWNER, prodNoAllowlist, throwingDb() as never)).resolves.toBe("paused");
  });
});
