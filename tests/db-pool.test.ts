/**
 * B5.2 — database pool hardening (no I/O performed).
 *
 * Verifies the shared pool is a singleton, carries an 'error' listener so
 * a terminated idle connection can never crash the process unhandled, and
 * can be closed cleanly. Opens no connections: safe without a live DB
 * beyond DATABASE_URL being set.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@/lib/db";

afterAll(async () => {
  await closePool();
});

describe("database pool hardening", () => {
  it("reuses a single pool instance", () => {
    expect(getPool()).toBe(getPool());
  });

  it("handles idle client errors without throwing", () => {
    const pool = getPool();
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("closes and recreates cleanly", async () => {
    const first = getPool();
    await closePool();
    const second = getPool();
    expect(second).not.toBe(first);
    expect(second.listenerCount("error")).toBeGreaterThan(0);
    await closePool();
  });
});
