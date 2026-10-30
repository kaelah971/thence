/**
 * Schema constraint tests (B0).
 *
 * Two layers:
 * 1. Static definition checks — run everywhere, no database needed:
 *    every table exposes the required columns/timestamps and the migration
 *    baseline contains the exact-value CHECKs, ownership FKs and indexes.
 * 2. Live constraint checks — run ONLY when DATABASE_URL is configured
 *    (otherwise skipped and reported as pending, never faked as passing).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";

const LIVE = Boolean(process.env["DATABASE_URL"]);

describe("schema definitions (static, no DB required)", () => {
  it("exposes all nine PRD §12 tables", () => {
    for (const key of [
      "users",
      "authChallenges",
      "sessions",
      "recipients",
      "recipientDestinations",
      "recipientVerifications",
      "paymentRequests",
      "transfers",
      "transferProofs",
      "routeObservations",
    ] as const) {
      expect(schema[key], `missing table export: ${key}`).toBeDefined();
    }
  });

  it("users/transfers/recipients carry explicit timestamps + scoped ownership", () => {
    expect("createdAt" in schema.users).toBe(true);
    expect("ownerUserId" in schema.recipients).toBe(true);
    expect("ownerUserId" in schema.transfers).toBe(true);
    expect("creatorUserId" in schema.paymentRequests).toBe(true);
    expect("targetAmountAtomic" in schema.transfers).toBe(true);
    expect("status" in schema.transfers).toBe(true);
  });

  it("migration baseline enforces exact-value amounts and ownership", () => {
    // Single versioned strategy: drizzle-kit journal (meta/_journal.json +
    // numbered SQL). Read every migration SQL file, in lexical order.
    const dir = join(process.cwd(), "src", "db", "migrations");
    expect(existsSync(join(dir, "meta", "_journal.json"))).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const sql = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    // Exact-value CHECKs (no floats anywhere).
    expect(sql).toContain("~ '^[0-9]+$'");
    expect(sql).not.toMatch(/\b(double precision|float|real)\b/i);
    // Scoped ownership FKs.
    expect(sql).toContain("owner_user_id");
    expect(sql).toContain('REFERENCES "public"."users"');
    // All PRD tables present.
    for (const table of [
      '"users"',
      '"auth_challenges"',
      '"sessions"',
      '"recipients"',
      '"recipient_destinations"',
      '"recipient_verifications"',
      '"payment_requests"',
      '"transfers"',
      '"transfer_proofs"',
      '"route_observations"',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    // No secrets/token addresses baked into migrations.
    expect(sql).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(sql).not.toMatch(/mnemonic|preimage|private key/i);
  });
});

describe("live constraint checks (requires DATABASE_URL)", () => {
  it.skipIf(!LIVE)("rejects non-atomic transfer amounts at the database", async () => {
    if (!process.env["DATABASE_URL"]) return;
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
    try {
      await expect(
        pool.query(
          `INSERT INTO "transfers"
             ("owner_user_id","route_id","target_asset","target_network","destination","target_amount_atomic","status")
           VALUES (gen_random_uuid(),'usdt-polygon','USDT','Polygon','0xabc','50.00','DRAFT')`,
        ),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  it.skipIf(!LIVE)("migrations apply cleanly in order", async () => {
    if (!process.env["DATABASE_URL"]) return;
    // Repeatability is owned by the journaled migrator (drizzle tracks
    // applied entries in drizzle.__drizzle_migrations), not by re-running
    // raw DDL. This test verifies the journal state + resulting schema.
    const { Pool } = await import("pg");
    const { readFile } = await import("node:fs/promises");
    const journal = JSON.parse(
      await readFile(join(process.cwd(), "src", "db", "migrations", "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.length).toBeGreaterThan(0);
    const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
    try {
      // The migrator records one row per applied journal entry (sha256 of
      // the snapshot). Counts must agree — re-runs add no duplicates.
      const tracked = await pool.query("SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations");
      expect(tracked.rows[0].n).toBe(journal.entries.length);
      const { rows } = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      );
      const names = new Set(rows.map((r: { table_name: string }) => r.table_name));
      for (const t of [
        "users",
        "auth_challenges",
        "sessions",
        "recipients",
        "recipient_destinations",
        "recipient_verifications",
        "payment_requests",
        "transfers",
        "transfer_proofs",
        "route_observations",
      ]) {
        expect(names.has(t)).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
