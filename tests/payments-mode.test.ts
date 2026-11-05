/**
 * Public launch — THENCE_PAYMENTS_MODE (pure, no database).
 *
 * Pins fail-closed resolution and what each mode admits:
 * - off:    every funded gate refuses (PAYMENTS_OFF), availability "paused".
 * - pilot:  unchanged restricted pilot (allowlist + caps).
 * - public: any authenticated wallet, any positive amount, any route the
 *           route layer enables — but the database kill switch still decides,
 *           and a read error is "paused", never permission.
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "@/lib/auth";
import {
  assertFundingExposure,
  assertPilotBudget,
  assertPilotDbEnabled,
  assertPilotIntent,
  getPilotConfig,
  isPilotDbEnabled,
  pilotPaymentAvailability,
  resolvePaymentsMode,
} from "@/lib/pilot";

const OWNER = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const STRANGER = "NQ52 1111 2222 3333 4444 5555 6666 7777 8888";

/** Minimal kill-switch read handle: returns the given row (or throws). */
function switchDb(enabled: boolean | "missing" | "error") {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      if (enabled === "error") throw new Error("relation does not exist");
      return enabled === "missing" ? [] : [{ enabled }];
    },
  };
  return { select: () => chain } as never;
}
/** A db handle that must never be touched. */
const untouchable = {
  select: () => {
    throw new Error("database must not be read here");
  },
} as never;

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | null> {
  try {
    await (typeof p === "function" ? p() : p);
    return null;
  } catch (e) {
    return e instanceof AuthError ? e.code : `non-auth:${(e as Error).message}`;
  }
}

describe("resolvePaymentsMode — fail closed", () => {
  it("accepts exactly off / pilot / public (case-insensitive)", () => {
    expect(resolvePaymentsMode({ THENCE_PAYMENTS_MODE: "public" })).toBe("public");
    expect(resolvePaymentsMode({ THENCE_PAYMENTS_MODE: " Pilot " })).toBe("pilot");
    expect(resolvePaymentsMode({ THENCE_PAYMENTS_MODE: "OFF" })).toBe("off");
  });
  it("invalid value → off, in every environment", () => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      for (const v of ["1", "true", "on", "open", "publicc", "all"]) expect(resolvePaymentsMode({ NODE_ENV, THENCE_PAYMENTS_MODE: v }), `${NODE_ENV}/${v}`).toBe("off");
    }
  });
  it("missing in production → off; missing elsewhere keeps the pre-mode (legacy) behaviour", () => {
    expect(resolvePaymentsMode({ NODE_ENV: "production" })).toBe("off");
    expect(resolvePaymentsMode({ NODE_ENV: "production", THENCE_PAYMENTS_MODE: "  " })).toBe("off");
    expect(resolvePaymentsMode({ NODE_ENV: "test" })).toBe("legacy");
  });
  it("production with the old pilot env but no mode is OFF (no silent pilot or public)", async () => {
    const cfg = getPilotConfig({ NODE_ENV: "production", THENCE_PILOT_ENABLED: "1", THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER });
    expect(cfg.mode).toBe("off");
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, cfg))).toBe("PAYMENTS_OFF");
    expect(await pilotPaymentAvailability(OWNER, cfg, switchDb(true))).toBe("paused");
  });
});

describe("mode off", () => {
  const cfg = getPilotConfig({ NODE_ENV: "production", THENCE_PAYMENTS_MODE: "off" });
  it("every funded gate refuses before any database read", async () => {
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "1", ownerAddress: OWNER }, cfg))).toBe("PAYMENTS_OFF");
    expect(await code(assertPilotDbEnabled(cfg, untouchable))).toBe("PAYMENTS_OFF");
    expect(await code(assertPilotBudget("u", "1", cfg, untouchable))).toBe("PAYMENTS_OFF");
    expect(await code(assertFundingExposure("u", "1", cfg, untouchable))).toBe("PAYMENTS_OFF");
    expect(await isPilotDbEnabled(cfg, switchDb(true))).toBe(false);
    expect(await pilotPaymentAvailability(OWNER, cfg, switchDb(true))).toBe("paused");
  });
});

describe("mode public", () => {
  // The old pilot env is still present to prove it is IGNORED in public mode.
  const cfg = getPilotConfig({
    NODE_ENV: "production",
    THENCE_PAYMENTS_MODE: "public",
    THENCE_PILOT_ENABLED: "0",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
    THENCE_PILOT_MAX_TARGET_ATOMIC: "300000",
    THENCE_PILOT_MAX_SPEND_ATOMIC: "300000",
  });

  it("admits any authenticated wallet, any positive amount, any route — no allowlist, no Thence cap", () => {
    for (const ownerAddress of [OWNER, STRANGER]) {
      for (const targetAmountAtomic of ["1", "300001", "25000000", "1000000000000"]) {
        for (const routeId of ["usdc-polygon", "usdt-arbitrum"]) {
          expect(() => assertPilotIntent({ routeId, targetAmountAtomic, ownerAddress }, cfg)).not.toThrow();
        }
      }
    }
  });

  it("still refuses an unauthenticated owner and malformed amounts", async () => {
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "1", ownerAddress: null }, cfg))).toBe("PAYMENTS_NOT_AUTHORIZED");
    for (const bad of ["0", "-1", "1.5", "", "1e6"]) {
      expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: bad, ownerAddress: STRANGER }, cfg)), bad).toBe("BAD_AMOUNT");
    }
  });

  it("the database kill switch decides: on → allowed; off, missing row or read error → PILOT_DISABLED", async () => {
    expect(await code(assertPilotDbEnabled(cfg, switchDb(true)))).toBeNull();
    for (const state of [false, "missing", "error"] as const) {
      expect(await code(assertPilotDbEnabled(cfg, switchDb(state))), String(state)).toBe("PILOT_DISABLED");
    }
  });

  it("availability follows only the switch, for a non-allowlisted wallet too", async () => {
    expect(await pilotPaymentAvailability(STRANGER, cfg, switchDb(true))).toBe("available");
    expect(await pilotPaymentAvailability(STRANGER, cfg, switchDb(false))).toBe("paused");
    expect(await pilotPaymentAvailability(null, cfg, switchDb(true))).toBe("paused");
  });

  it("no spend ceiling: the budget check never reads or refuses", async () => {
    expect(await code(assertPilotBudget("u", "999999999999999", cfg, untouchable))).toBeNull();
  });
});

describe("mode pilot — unchanged restricted pilot", () => {
  const cfg = getPilotConfig({
    NODE_ENV: "production",
    THENCE_PAYMENTS_MODE: "pilot",
    THENCE_PILOT_ENABLED: "1",
    THENCE_PILOT_OWNER_NIMIQ_ADDRESSES: OWNER,
    THENCE_PILOT_MAX_TARGET_ATOMIC: "300000",
  });
  it("non-allowlisted wallet, other route and over-cap amounts are still refused", async () => {
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: STRANGER }, cfg))).toBe("PILOT_NOT_AUTHORIZED");
    expect(await code(() => assertPilotIntent({ routeId: "usdt-arbitrum", targetAmountAtomic: "300000", ownerAddress: OWNER }, cfg))).toBe("PILOT_ROUTE_ONLY");
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300001", ownerAddress: OWNER }, cfg))).toBe("PILOT_AMOUNT_EXCEEDS_MAX");
    expect(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "300000", ownerAddress: OWNER }, cfg)).not.toThrow();
  });
  it("pilot mode with an empty allowlist in production fails closed", async () => {
    const empty = getPilotConfig({ NODE_ENV: "production", THENCE_PAYMENTS_MODE: "pilot", THENCE_PILOT_ENABLED: "1" });
    expect(await code(() => assertPilotIntent({ routeId: "usdc-polygon", targetAmountAtomic: "1", ownerAddress: OWNER }, empty))).toBe("PILOT_NOT_AUTHORIZED");
  });
});
