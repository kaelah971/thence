/**
 * F8.1 — pilot attempt-limit regression tests (isolated TEST database).
 *
 * F8.2 two-key rule: these tests arm the env gate (KEY 1) AND the database
 * switch (KEY 2, restored to DISABLED afterwards). Production stays OFF.
 *
 * Proves the independent intent, exposure and spend gates at the route level
 * with the pilot armed, using real quotes (no swaps, no invoices, no funds move):
 * - First pilot transfer creates (201) when correctly configured.
 * - A second distinct quoted intent is allowed, but a second handoff exposure is rejected.
 * - Same-key replay stays deduplicated (no duplicate transfer).
 * - Spend cap enforced independently of exposure count.
 * - Armed-without-allowlist and disarmed configurations stay fail-closed.
 * - Concurrent different-key creates remain independent.
 *
 * Guard: the whole suite is LIVE-gated — it runs ONLY against the isolated
 * Neon TEST database installed by vitest.setup.ts (see tests/test-db.ts).
 * Generic DATABASE_URL alone runs nothing here. Never production.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { pilotControls, reconciliationObservations, transfers, users } from "@/db/schema";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { GET as reconciliationGet } from "../app/api/transfers/[id]/reconciliation/route";
import { isLiveTestingEnabled } from "./test-db";
import { LIVE, RUN, loginAs, postJson } from "./helpers";
import { GET as transfersGet, POST as createTransferPost } from "../app/api/transfers/route";
import { GET as pilotStatusGet } from "../app/api/pilot/status/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
  // Leave the shared switch DISABLED (fail-closed default) for any later suite.
  await getDb()
    .insert(pilotControls)
    .values({ id: "pilot", enabled: false })
    .onConflictDoUpdate({ target: pilotControls.id, set: { enabled: false, updatedAt: new Date() } });
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `f81-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));

const EVM_A = "0x0000000000000000000000000000000000000001";
const PILOT_KEYS = [
  "THENCE_ENABLED_ROUTES",
  "THENCE_PILOT_ENABLED",
  "THENCE_PILOT_OWNER_NIMIQ_ADDRESSES",
  "THENCE_PILOT_MAX_TARGET_ATOMIC",
  "THENCE_PILOT_MAX_SPEND_ATOMIC",
  "THENCE_PILOT_MAX_TRANSFERS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of PILOT_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of PILOT_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

/**
 * F8.2 two-key rule: arming the env gate (KEY 1) alone authorizes nothing.
 * Tests that expect funded execution must also enable the database switch
 * (KEY 2) and restore it to DISABLED afterwards. Production stays OFF.
 */
async function setPilotDb(enabled: boolean): Promise<void> {
  await getDb()
    .insert(pilotControls)
    .values({ id: "pilot", enabled })
    .onConflictDoUpdate({ target: pilotControls.id, set: { enabled, updatedAt: new Date() } });
}

/** Arm the disarmed pilot for one owner (tests only; production stays OFF). */
async function armFor(address: string, over: Record<string, string> = {}): Promise<void> {
  process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
  process.env["THENCE_PILOT_ENABLED"] = "1";
  process.env["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"] = address;
  delete process.env["THENCE_PILOT_MAX_TARGET_ATOMIC"];
  delete process.env["THENCE_PILOT_MAX_SPEND_ATOMIC"];
  delete process.env["THENCE_PILOT_MAX_TRANSFERS"];
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
  await setPilotDb(true);
}

/** Restore the database switch to fail-closed DISABLED. */
async function disarmDb(): Promise<void> {
  await setPilotDb(false);
}

async function createDirect(
  cookie: string,
  tag: string,
  keySuffix: string,
  targetAmountAtomic: string,
): Promise<{ status: number; body: any }> {
  const res = await createTransferPost(
    postJson(
      "http://localhost/api/transfers",
      {
        routeId: "usdc-polygon",
        targetAmountAtomic,
        idempotencyKey: `k-${RUN}-${keySuffix}`,
        recipientName: "Pilot",
        direct: { asset: "USDC", network: "Polygon", address: EVM_A },
      },
      { cookie, ...withClient(`mk-${tag}`) },
    ),
  );
  return { status: res.status, body: await res.json() };
}

async function ownerTransferCount(userId: string): Promise<number> {
  const rows = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));
  return rows.length;
}

describe.skipIf(!LIVE)("F8.1 pilot attempt limits (isolated TEST database)", () => {
  it("guard: live tests run only against the isolated test database", () => {
    expect(LIVE).toBe(true);
    expect(isLiveTestingEnabled(process.env)).toBe(true);
  });

  it("creates independent intents, blocks a second exposure, and replays idempotency", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("first");
      await armFor(me.address, { THENCE_PILOT_MAX_SPEND_ATOMIC: "600000" });
      const first = await createDirect(me.cookie, "first", "t1", "300000");
      expect(first.status).toBe(201);
      expect(first.body.transfer?.id).toMatch(/^[0-9a-f-]{36}$/i);

      const prepared = await preparePost(
        postJson(
          `http://localhost/api/transfers/${first.body.transfer.id}/prepare`,
          { expectedQuoteRevision: 1 },
          { cookie: me.cookie, ...withClient("first-prepare") },
        ),
        { params: Promise.resolve({ id: first.body.transfer.id }) },
      );
      expect(prepared.status).toBe(201);

      const second = await createDirect(me.cookie, "first", "t2", "300000");
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("PILOT_EXPOSURE_LIMIT");

      const replay = await createDirect(me.cookie, "first", "t1", "300000");
      expect(replay.status).toBe(200);
      expect(replay.body.deduplicated).toBe(true);
      expect(replay.body.transfer?.id).toBe(first.body.transfer?.id);
      expect(await ownerTransferCount(me.userId)).toBe(1);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("creates a fresh intent beside an unresolved RECONCILING transfer", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("reconciling");
      await armFor(me.address, { THENCE_PILOT_MAX_TRANSFERS: "2", THENCE_PILOT_MAX_SPEND_ATOMIC: "600000" });
      const first = await createDirect(me.cookie, "reconciling", "old", "300000");
      expect(first.status).toBe(201);
      const firstPrepared = await preparePost(
        postJson(`http://localhost/api/transfers/${first.body.transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: me.cookie, ...withClient("reconciling-first") }),
        { params: Promise.resolve({ id: first.body.transfer.id }) },
      );
      expect(firstPrepared.status).toBe(201);
      // Model the production recovery state without invoking a wallet,
      // provider swap, invoice or settlement.
      await getDb().update(transfers).set({ status: "RECONCILING" }).where(eq(transfers.id, first.body.transfer.id));

      const second = await createDirect(me.cookie, "reconciling", "new", "300000");
      expect(second.status).toBe(201);
      expect(second.body.transfer.id).not.toBe(first.body.transfer.id);
      const secondPrepared = await preparePost(
        postJson(`http://localhost/api/transfers/${second.body.transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: me.cookie, ...withClient("reconciling-second") }),
        { params: Promise.resolve({ id: second.body.transfer.id }) },
      );
      expect(secondPrepared.status).toBe(201);
      expect(await ownerTransferCount(me.userId)).toBe(2);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("releases exactly one slot only after durable REFUNDED reconciliation", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("refund-release");
      await armFor(me.address, { THENCE_PILOT_MAX_TRANSFERS: "1", THENCE_PILOT_MAX_SPEND_ATOMIC: "600000" });
      const refunded = await createDirect(me.cookie, "refund-release", "refunded", "300000");
      expect(refunded.status).toBe(201);
      await getDb().update(transfers).set({ status: "SERVER_FUNDED" }).where(eq(transfers.id, refunded.body.transfer.id));
      // Provider observations alone are not independent refund proof and do
      // not spoof Activity or release the exposure slot.
      await getDb().insert(reconciliationObservations).values({
        transferId: refunded.body.transfer.id,
        satoraSwapId: "swap-refunded",
        providerStatus: "clientfundedserverrefunded",
        kind: "observation",
      });
      const before = await transfersGet(new Request("http://localhost/api/transfers", { headers: { cookie: me.cookie } }));
      const beforeBody = (await before.json()) as { transfers: Array<{ id: string; status: string }> };
      expect(beforeBody.transfers.find((row) => row.id === refunded.body.transfer.id)?.status).toBe("SERVER_FUNDED");
      const blocked = await createDirect(me.cookie, "refund-release", "blocked", "300000");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("PILOT_EXPOSURE_LIMIT");

      // The reconciler is the only path that may durably release the slot;
      // model its terminal result here without a provider or wallet action.
      await getDb().update(transfers).set({ status: "REFUNDED" }).where(eq(transfers.id, refunded.body.transfer.id));
      const listed = await transfersGet(new Request("http://localhost/api/transfers", { headers: { cookie: me.cookie } }));
      const listedBody = (await listed.json()) as { transfers: Array<{ id: string; status: string; statusLabel: string }> };
      expect(listedBody.transfers.find((row) => row.id === refunded.body.transfer.id)).toMatchObject({
        status: "REFUNDED",
        statusLabel: "Not delivered — Polygon lock refunded",
      });

      const fresh = await createDirect(me.cookie, "refund-release", "fresh", "300000");
      expect(fresh.status).toBe(201);
      expect(await ownerTransferCount(me.userId)).toBe(2);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("allows bounded parallel exposure only with an explicit larger test configuration", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("parallel");
      await armFor(me.address, { THENCE_PILOT_MAX_TRANSFERS: "2", THENCE_PILOT_MAX_SPEND_ATOMIC: "600000" });
      const first = await createDirect(me.cookie, "parallel", "p1", "300000");
      const second = await createDirect(me.cookie, "parallel", "p2", "300000");
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.transfer.id).not.toBe(second.body.transfer.id);

      const firstPrepared = await preparePost(
        postJson(`http://localhost/api/transfers/${first.body.transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: me.cookie, ...withClient("parallel-first") }),
        { params: Promise.resolve({ id: first.body.transfer.id }) },
      );
      const secondPrepared = await preparePost(
        postJson(`http://localhost/api/transfers/${second.body.transfer.id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: me.cookie, ...withClient("parallel-second") }),
        { params: Promise.resolve({ id: second.body.transfer.id }) },
      );
      expect(firstPrepared.status).toBe(201);
      expect(secondPrepared.status).toBe(201);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("enforces spend independently after a payment is delivered", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("spend");
      await armFor(me.address, { THENCE_PILOT_MAX_TRANSFERS: "10", THENCE_PILOT_MAX_SPEND_ATOMIC: "300000" });
      const first = await createDirect(me.cookie, "spend", "s1", "300000");
      expect(first.status).toBe(201);
      await getDb().update(transfers).set({ status: "DELIVERED" }).where(eq(transfers.id, first.body.transfer.id));
      // Delivered spend consumes the spend ceiling, while the transfer-count
      // ceiling remains independent.
      const over = await createDirect(me.cookie, "spend", "s2", "100000");
      expect(over.status).toBe(403);
      expect(over.body.error).toBe("PILOT_SPEND_EXCEEDED");
      expect(await ownerTransferCount(me.userId)).toBe(1);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("fail-closed: armed without allowlist, and disarmed with allowlist", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("closed");
      // F8.2: database switch ON proves the env key alone still blocks.
      await setPilotDb(true);
      // Armed but no allowlist: incomplete configuration blocks everything.
      process.env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
      process.env["THENCE_PILOT_ENABLED"] = "1";
      delete process.env["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"];
      const missing = await createDirect(me.cookie, "closed", "m1", "300000");
      expect(missing.status).toBe(403);
      expect(missing.body.error).toBe("PILOT_NOT_AUTHORIZED");
      // Allowlisted but kill switch OFF: disarmed blocks.
      process.env["THENCE_PILOT_ENABLED"] = "0";
      process.env["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"] = me.address;
      const off = await createDirect(me.cookie, "closed", "m2", "300000");
      expect(off.status).toBe(403);
      expect(off.body.error).toBe("PILOT_DISABLED");
      expect(await ownerTransferCount(me.userId)).toBe(0);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("concurrent different-key creates remain independent", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("race");
      await armFor(me.address);
      const [a, b] = await Promise.all([
        createDirect(me.cookie, "race", "r1", "300000"),
        createDirect(me.cookie, "race", "r2", "300000"),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(await ownerTransferCount(me.userId)).toBe(2);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });
});

/**
 * F8.2 live section — same file as F8.1 ON PURPOSE. Both suites mutate the
 * single shared `pilot_controls` row, so they must run sequentially in one
 * file (vitest parallelizes across files). Splitting them reintroduces a
 * cross-worker race: one suite's disable/delete lands in the other's armed
 * window and armed creates fail with PILOT_DISABLED.
 */
describe.skipIf(!LIVE)("F8.2 database kill switch (isolated TEST database)", () => {
  it("armed env + DISABLED database blocks new transfers (KEY 2 stops alone)", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("stopped");
      await armFor(me.address);
      await setPilotDb(false);
      const res = await createDirect(me.cookie, "stopped", "db-off", "300000");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("PILOT_DISABLED");
      const rows = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, me.userId));
      expect(rows).toHaveLength(0);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("emergency stop after funding: requote/prepare blocked, recovery still answers", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("stop");
      await armFor(me.address);
      const first = await createDirect(me.cookie, "stop", "funded", "300000");
      expect(first.status).toBe(201);
      const transferId = first.body.transfer?.id as string;
      expect(transferId).toMatch(/^[0-9a-f-]{36}$/i);

      // Emergency stop: flip KEY 2 off (no redeploy).
      await setPilotDb(false);

      // New funding preparation is blocked on every path that spends.
      const { POST: requotePost } = await import("../app/api/transfers/[id]/requote/route");
      const rq = await requotePost(
        postJson("http://localhost/api/transfers/x/requote", { expectedQuoteRevision: 1 }, { cookie: me.cookie, ...withClient("stop-rq") }),
        { params: Promise.resolve({ id: transferId }) },
      );
      expect(rq.status).toBe(403);
      expect((await rq.json()).error).toBe("PILOT_DISABLED");

      const prep = await preparePost(
        postJson(
          "http://localhost/api/transfers/x/prepare",
          { expectedQuoteRevision: 1 },
          { cookie: me.cookie, ...withClient("stop-prep") },
        ),
        { params: Promise.resolve({ id: transferId }) },
      );
      expect(prep.status).toBe(403);
      expect((await prep.json()).error).toBe("PILOT_DISABLED");

      // Recovery stays available while stopped: resume reads answer.
      const resume = await reconciliationGet(
        new Request("http://localhost/api/transfers/x/reconciliation", {
          headers: { cookie: me.cookie, ...withClient("stop-resume") },
        }),
        { params: Promise.resolve({ id: transferId }) },
      );
      expect(resume.status).toBe(200);
      const resumeBody = (await resume.json()) as { transfer: { id: string } };
      expect(resumeBody.transfer.id).toBe(transferId);

      // Cross-user reads stay owner-bound while stopped (no pilot bypass).
      const other = await login("stop-other");
      const foreign = await reconciliationGet(
        new Request("http://localhost/api/transfers/x/reconciliation", {
          headers: { cookie: other.cookie, ...withClient("stop-foreign") },
        }),
        { params: Promise.resolve({ id: transferId }) },
      );
      expect(foreign.status).toBe(404);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("missing database row reads as DISABLED (fail-closed)", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("norow");
      await armFor(me.address);
      await getDb().delete(pilotControls).where(eq(pilotControls.id, "pilot"));
      const res = await createDirect(me.cookie, "norow", "missing-row", "300000");
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("PILOT_DISABLED");
    } finally {
      await setPilotDb(false);
      restoreEnv(saved);
    }
  });

  /**
   * Phone smoke test 2026-11-04: an owner with an unresolved earlier payment
   * (exposure held) tried a new payment while the pilot was stopped. The
   * stopped pilot must answer PILOT_DISABLED ("payments temporarily
   * unavailable"), not an exposure code; once re-enabled, the earlier
   * payment must still block the new one (duplicate protection preserved).
   */
  it("stopped pilot reports PILOT_DISABLED even while exposure is held; re-enabled, exposure still blocks", async () => {
    const saved = snapshotEnv();
    try {
      const me = await login("stopped-exposed");
      await armFor(me.address);
      const first = await createDirect(me.cookie, "stopped-exposed", "held", "300000");
      expect(first.status).toBe(201);
      const prepared = await preparePost(
        postJson(
          `http://localhost/api/transfers/${first.body.transfer.id}/prepare`,
          { expectedQuoteRevision: 1 },
          { cookie: me.cookie, ...withClient("stopped-exposed-prepare") },
        ),
        { params: Promise.resolve({ id: first.body.transfer.id }) },
      );
      expect(prepared.status).toBe(201);

      await setPilotDb(false);
      const stopped = await createDirect(me.cookie, "stopped-exposed", "new-while-stopped", "300000");
      expect(stopped.status).toBe(403);
      expect(stopped.body.error).toBe("PILOT_DISABLED");
      expect(await ownerTransferCount(me.userId)).toBe(1);

      await setPilotDb(true);
      const blocked = await createDirect(me.cookie, "stopped-exposed", "new-while-exposed", "300000");
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("PILOT_EXPOSURE_LIMIT");
      expect(await ownerTransferCount(me.userId)).toBe(1);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });

  it("GET /api/pilot/status: session required, read-only, mirrors both keys", async () => {
    const saved = snapshotEnv();
    const status = async (cookie?: string) => {
      const res = await pilotStatusGet(new Request("http://localhost/api/pilot/status", { headers: cookie ? { cookie } : {} }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      expect((await status()).status).toBe(401);
      const me = await login("status");
      await armFor(me.address);
      const on = await status(me.cookie);
      expect(on).toEqual({ status: 200, body: { payments: "available" } });
      await setPilotDb(false);
      expect((await status(me.cookie)).body).toEqual({ payments: "paused" });
      await setPilotDb(true);
      process.env["THENCE_PILOT_ENABLED"] = "0";
      expect((await status(me.cookie)).body).toEqual({ payments: "paused" });
      process.env["THENCE_PILOT_ENABLED"] = "1";
      process.env["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"] = "NQ52 1111 1111 1111 1111 1111 1111 1111 1111";
      expect((await status(me.cookie)).body).toEqual({ payments: "paused" });
      // Status checks never create anything.
      expect(await ownerTransferCount(me.userId)).toBe(0);
    } finally {
      restoreEnv(saved);
      await disarmDb();
    }
  });
});

/**
 * F8.3 live section — same file ON PURPOSE (see F8.2 note above): the
 * production-mandatory rule is proven end-to-end against the isolated
 * TEST database with NODE_ENV=production: a production runtime with an
 * enabled route, a payment-capable client posture, and NO allowlist must
 * fail closed (PILOT_NOT_AUTHORIZED) even with the database switch ON.
 */
describe.skipIf(!LIVE)("F8.3 production-mandatory allowlist (isolated TEST database)", () => {
  it("production without allowlist blocks creation (missing-allowlist bypass closed)", async () => {
    const saved = snapshotEnv();
    const env = process.env as Record<string, string | undefined>;
    const savedNodeEnv = env["NODE_ENV"];
    const savedOrigin = env["THENCE_APP_ORIGIN"];
    const savedMode = env["THENCE_PAYMENTS_MODE"];
    try {
      // Production runtime posture with no allowlist configured.
      env["NODE_ENV"] = "production";
      env["THENCE_APP_ORIGIN"] = "https://pilot-test.invalid";
      env["THENCE_ENABLED_ROUTES"] = "usdc-polygon";
      delete env["THENCE_PILOT_ENABLED"];
      delete env["THENCE_PILOT_OWNER_NIMIQ_ADDRESSES"];
      // Database switch ON proves it cannot compensate for the missing allowlist.
      await setPilotDb(true);
      const me = await login("prod-norow");
      // Public launch: pilot mode keeps the production-mandatory allowlist;
      // with no mode at all, production refuses even earlier (PAYMENTS_OFF).
      for (const [mode, code] of [["pilot", "PILOT_NOT_AUTHORIZED"], [undefined, "PAYMENTS_OFF"]] as const) {
        if (mode === undefined) delete env["THENCE_PAYMENTS_MODE"];
        else env["THENCE_PAYMENTS_MODE"] = mode;
        const res = await createDirect(me.cookie, "prod-norow", `prod-missing-allowlist-${mode ?? "unset"}`, "300000");
        expect(res.status, String(mode)).toBe(403);
        expect(res.body.error, String(mode)).toBe(code);
      }
      const rows = await getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, me.userId));
      expect(rows).toHaveLength(0);
    } finally {
      if (savedMode === undefined) delete env["THENCE_PAYMENTS_MODE"];
      else env["THENCE_PAYMENTS_MODE"] = savedMode;
      if (savedNodeEnv === undefined) delete env["NODE_ENV"];
      else env["NODE_ENV"] = savedNodeEnv;
      if (savedOrigin === undefined) delete env["THENCE_APP_ORIGIN"];
      else env["THENCE_APP_ORIGIN"] = savedOrigin;
      restoreEnv(saved);
      await disarmDb();
    }
  });
});
