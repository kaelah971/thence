/**
 * R4 TLS hardening — pre-existing operator database scripts.
 *
 * Before this change `scripts/db-guard.ts` (the anchor probe every local
 * writer and the production path of `pilot-switch.ts` rely on) connected with
 * `ssl: { rejectUnauthorized: false }`, and `pilot-switch.ts` did the same for
 * `--production`. Both now use the certificate-verified config introduced for
 * the diagnostics script (`scripts/db-tls.ts`).
 *
 * Pure and offline: `pg` is mocked, every URL is an obviously fake fixture,
 * no credential or connection string is real, and no socket is opened.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

const pgMock = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  statements: [] as string[],
  present: true,
  projectId: "project-under-test" as string | null,
  connectError: null as Error | null,
  ended: 0,
}));

vi.mock("pg", () => {
  class Client {
    constructor(config: Record<string, unknown>) {
      pgMock.configs.push(config);
    }
    async connect(): Promise<void> {
      if (pgMock.connectError) throw pgMock.connectError;
    }
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      pgMock.statements.push(sql);
      if (/^BEGIN TRANSACTION READ ONLY$/i.test(sql) || /^ROLLBACK$/i.test(sql)) return { rows: [] };
      if (/to_regclass/i.test(sql)) return { rows: [{ present: pgMock.present }] };
      if (/project_id/i.test(sql)) return { rows: pgMock.projectId === null ? [] : [{ project_id: pgMock.projectId }] };
      throw new Error(`unexpected statement: ${sql}`);
    }
    async end(): Promise<void> {
      pgMock.ended += 1;
    }
  }
  return { Client };
});

import { probeAnchor, sameDatabase, verifyNonProductionTarget } from "../scripts/db-guard";
import { verifiedClientConfig } from "../scripts/db-tls";
import { confirmationRequired, isPilotCommand, productionTargetVerdict } from "../scripts/pilot-switch-policy";

const TLS_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslcrl", "uselibpqcompat"];

const REMOTE =
  "postgresql://app_user:fake-pw@ep-test-123.eu-central-1.aws.neon.tech:5432/staging?sslmode=no-verify&sslrootcert=/tmp/fake.pem&application_name=thence";
const REMOTE_CLEAN = "postgresql://app_user:fake-pw@ep-test-123.eu-central-1.aws.neon.tech:5432/staging";
const PROD = "postgresql://neondb_owner:fake-prod-pw@ep-prod-999.region.aws.neon.invalid:5432/neondb";
const LOCAL = "postgresql://postgres:postgres@localhost:5432/thence";

beforeEach(() => {
  pgMock.configs.length = 0;
  pgMock.statements.length = 0;
  pgMock.present = true;
  pgMock.projectId = "project-under-test";
  pgMock.connectError = null;
  pgMock.ended = 0;
});

describe("certificate-verified remote connections", () => {
  it("always requests verification and strips URL TLS overrides", () => {
    const cfg = verifiedClientConfig(REMOTE);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    const url = new URL(cfg.connectionString);
    for (const p of TLS_PARAMS) expect(url.searchParams.has(p)).toBe(false);
    // Non-TLS parameters, credentials, host, port and database are untouched.
    expect(url.searchParams.get("application_name")).toBe("thence");
    expect(url.hostname).toBe("ep-test-123.eu-central-1.aws.neon.tech");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/staging");
    expect(url.username).toBe("app_user");
    expect(url.password).toBe("fake-pw");
  });

  it("defeats every known hostile TLS parameter, including sslmode=no-verify", () => {
    for (const param of [
      "sslmode=no-verify",
      "sslmode=disable",
      "sslmode=prefer",
      "ssl=false",
      "sslcert=/tmp/fake.crt",
      "sslkey=/tmp/fake.key",
      "sslrootcert=/tmp/fake.pem",
      "sslcrl=/tmp/fake.crl",
      "uselibpqcompat=true",
    ]) {
      const cfg = verifiedClientConfig(`postgresql://u:p@db.example.invalid/app?${param}`);
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
      const name = param.split("=")[0] ?? "";
      expect(new URL(cfg.connectionString).searchParams.has(name)).toBe(false);
    }
  });

  it("the anchor probe itself connects with the verified config", async () => {
    await probeAnchor(REMOTE);
    expect(pgMock.configs).toHaveLength(1);
    expect(pgMock.configs[0]?.["ssl"]).toEqual({ rejectUnauthorized: true });
    expect(String(pgMock.configs[0]?.["connectionString"])).not.toMatch(/sslmode|no-verify/);
    expect(pgMock.configs[0]?.["connectionTimeoutMillis"]).toBe(15_000);
    expect(pgMock.configs[0]?.["statement_timeout"]).toBe(15_000);
  });

  it("an unparseable target opens no connection and fails closed", async () => {
    expect(() => verifiedClientConfig("not-a-url")).toThrow();
    expect(await probeAnchor("not-a-url")).toEqual({ anchored: false, projectId: null, reason: "unreachable" });
    expect(pgMock.configs).toHaveLength(0);
  });
});

describe("untrusted certificate rejection", () => {
  it("fails closed when the handshake is rejected", async () => {
    pgMock.connectError = Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    expect(await probeAnchor(REMOTE)).toEqual({ anchored: false, projectId: null, reason: "unreachable" });
    // Verification was requested (so the rejection is what stopped it) and the
    // probe never fell back to an unverified connection.
    expect(pgMock.configs.every((c) => JSON.stringify(c["ssl"]) === JSON.stringify({ rejectUnauthorized: true }))).toBe(true);
    expect(pgMock.statements).toHaveLength(0);
  });

  it("never downgrades to rejectUnauthorized:false, even after a failure", async () => {
    pgMock.connectError = Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    await probeAnchor(REMOTE);
    expect(pgMock.configs).toHaveLength(1);
    expect(pgMock.configs[0]?.["ssl"]).toEqual({ rejectUnauthorized: true });
  });
});

describe("localhost behaviour is unchanged", () => {
  it("uses no TLS and keeps the URL verbatim", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = `postgresql://postgres:postgres@${host}:5432/thence`;
      expect(verifiedClientConfig(url)).toEqual({ connectionString: url, ssl: undefined });
    }
  });

  it("a remote hostname that merely contains 'localhost' is still verified", () => {
    expect(verifiedClientConfig("postgresql://u:p@localhost.example.invalid/db").ssl).toEqual({ rejectUnauthorized: true });
  });

  it("the probe opens a TLS-less localhost connection", async () => {
    await probeAnchor(LOCAL);
    expect(pgMock.configs[0]?.["ssl"]).toBeUndefined();
    expect(pgMock.configs[0]?.["connectionString"]).toBe(LOCAL);
  });
});

describe("database anchor probe", () => {
  it("reports an anchored database and stays read-only", async () => {
    expect(await probeAnchor(REMOTE)).toEqual({ anchored: true, projectId: "project-under-test", reason: "anchored" });
    expect(pgMock.statements[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(pgMock.statements.at(-1)).toBe("ROLLBACK");
    for (const sql of pgMock.statements) expect(sql).toMatch(/^(BEGIN TRANSACTION READ ONLY|ROLLBACK|SELECT\s)/i);
    expect(pgMock.statements.join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|COMMIT)\b/i);
    expect(pgMock.ended).toBe(1);
  });

  it("reports a missing anchor row as no-anchor", async () => {
    pgMock.projectId = null;
    expect(await probeAnchor(REMOTE)).toEqual({ anchored: false, projectId: null, reason: "no-anchor" });
    expect(pgMock.statements.at(-1)).toBe("ROLLBACK");
  });

  it("reports a missing marker table as no-anchor", async () => {
    pgMock.present = false;
    expect(await probeAnchor(REMOTE)).toEqual({ anchored: false, projectId: null, reason: "no-anchor" });
    expect(pgMock.statements.at(-1)).toBe("ROLLBACK");
  });

  it("an unreachable database fails closed", async () => {
    pgMock.connectError = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(await probeAnchor(REMOTE)).toEqual({ anchored: false, projectId: null, reason: "unreachable" });
    expect(pgMock.statements).toHaveLength(0);
  });

  it("never returns or logs the connection string or credentials", async () => {
    const probe = await probeAnchor(REMOTE);
    expect(JSON.stringify(probe)).not.toContain("fake-pw");
    expect(JSON.stringify(probe)).not.toContain("neon.tech");
  });
});

describe("production / non-production target refusal", () => {
  it("refuses the production reference (pooler-normalized) without probing", async () => {
    let probed = false;
    const spy = async () => {
      probed = true;
      return { anchored: false, projectId: null, reason: "no-anchor" as const };
    };
    const pooler = PROD.replace("ep-prod-999", "ep-prod-999-pooler");
    expect(await verifyNonProductionTarget(pooler, PROD, spy)).toEqual({ ok: false, reason: "matches-production-reference" });
    expect(probed).toBe(false);
  });

  it("refuses a remote local target that cannot prove the test anchor", async () => {
    pgMock.present = false;
    expect(await verifyNonProductionTarget(REMOTE_CLEAN, null)).toEqual({ ok: false, reason: "no-anchor" });
    expect(sameDatabase(REMOTE, REMOTE_CLEAN)).toBe(true);
  });

  it("pilot-switch --production is allowed only for a database without the test anchor", () => {
    expect(productionTargetVerdict("no-anchor")).toBe("allowed");
    expect(productionTargetVerdict("anchored")).toBe("refused-anchored");
    expect(productionTargetVerdict("unreachable")).toBe("refused-unreachable");
  });
});

describe("emergency-switch authorization is preserved", () => {
  it("accepts only the three operator commands", () => {
    expect(isPilotCommand("status")).toBe(true);
    expect(isPilotCommand("enable")).toBe(true);
    expect(isPilotCommand("disable")).toBe(true);
    for (const bad of ["fund", "off", "", undefined]) expect(isPilotCommand(bad as string | undefined)).toBe(false);
  });

  it("requires --yes exactly where it did before the TLS change", () => {
    // Local non-production: enable always; disable (the emergency stop) never.
    expect(confirmationRequired("status", false)).toBe(false);
    expect(confirmationRequired("enable", false)).toBe(true);
    expect(confirmationRequired("disable", false)).toBe(false);
    // Production: every write, including disable, needs explicit confirmation.
    expect(confirmationRequired("status", true)).toBe(false);
    expect(confirmationRequired("enable", true)).toBe(true);
    expect(confirmationRequired("disable", true)).toBe(true);
  });

  it("the switch mechanics are untouched by the TLS change", () => {
    const src = readFileSync("scripts/pilot-switch.ts", "utf8");
    expect(src).toContain("UPDATE pilot_controls SET enabled = $1");
    expect(src).toContain("verifiedClientConfig");
    expect(src).not.toMatch(/rejectUnauthorized/);
    // The check runs before any client is constructed.
    expect(src.indexOf("confirmationRequired(command, false)")).toBeLessThan(src.indexOf("new Client("));
  });
});

describe("no operator script keeps an unverified TLS path", () => {
  it("no file under scripts/ disables certificate verification", () => {
    // Comment lines are skipped: prose that names the forbidden setting is not code.
    const code = (file: string) =>
      readFileSync(`scripts/${file}`, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
    const offenders = readdirSync("scripts")
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /rejectUnauthorized\s*:\s*false/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("every script that opens a client uses the verified config", () => {
    for (const f of ["scripts/db-guard.ts", "scripts/pilot-switch.ts", "scripts/fastspot-diag.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("verifiedClientConfig");
    }
  });
});
