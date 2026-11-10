import { describe, expect, it } from "vitest";
import { validateEnv, parseEnabledRoutes } from "@/lib/env";

describe("environment validation (B0)", () => {
  it("accepts a minimal valid configuration", () => {
    const result = validateEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing DATABASE_URL", () => {
    const result = validateEnv({ NODE_ENV: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join(".").includes("DATABASE_URL"))).toBe(true);
    }
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const result = validateEnv({ NODE_ENV: "test", DATABASE_URL: "mysql://x" });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed route token JSON without leaking values", () => {
    const result = validateEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
      THENCE_ROUTE_TOKENS_JSON: "not-json",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-address token value", () => {
    const result = validateEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
      THENCE_ROUTE_TOKENS_JSON: JSON.stringify({ "usdt-polygon": "0x123" }),
    });
    expect(result.ok).toBe(false);
  });

  it("requires a separate HTTPS Nimiq source-proof RPC when configured", () => {
    const base = {
      NODE_ENV: "test" as const,
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
    };
    expect(validateEnv({ ...base, THENCE_NIMIQ_PROOF_RPC_URL: "https://nim.example/rpc" }).ok).toBe(true);
    expect(validateEnv({ ...base, THENCE_NIMIQ_PROOF_RPC_URL: "http://nim.example/rpc" }).ok).toBe(false);
  });

  it("accepts verified token map + parses enabled routes", () => {
    const result = validateEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
      THENCE_ENABLED_ROUTES: "usdt-polygon, usdc-base",
      THENCE_ROUTE_TOKENS_JSON: JSON.stringify({
        "usdt-polygon": "0x0000000000000000000000000000000000000001",
      }),
    });
    expect(result.ok).toBe(true);
    expect(parseEnabledRoutes("usdt-polygon, usdc-base")).toEqual(["usdt-polygon", "usdc-base"]);
    expect(parseEnabledRoutes("")).toEqual([]);
  });
});

describe("production origin protection (Slice 0 C5)", () => {
  const base = {
    NODE_ENV: "production" as const,
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
  };

  it("accepts a valid https origin in production", () => {
    const result = validateEnv({ ...base, THENCE_APP_ORIGIN: "https://pay.example.com" });
    expect(result.ok).toBe(true);
  });

  it("accepts https with a trailing slash in production", () => {
    const result = validateEnv({ ...base, THENCE_APP_ORIGIN: "https://pay.example.com/" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing origin in production", () => {
    const result = validateEnv({ ...base });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.join(".") === "THENCE_APP_ORIGIN")).toBe(true);
    }
  });

  it("rejects localhost and loopback origins in production", () => {
    for (const origin of [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://127.0.0.1:3000",
      "http://127.0.0.1",
      "https://0.0.0.0",
    ]) {
      const result = validateEnv({ ...base, THENCE_APP_ORIGIN: origin });
      expect(result.ok, origin).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.path.join(".") === "THENCE_APP_ORIGIN")).toBe(true);
      }
    }
  });

  it("rejects plain http origins in production", () => {
    const result = validateEnv({ ...base, THENCE_APP_ORIGIN: "http://pay.example.com" });
    expect(result.ok).toBe(false);
  });

  it("preserves local development behaviour (empty = relative links)", () => {
    const dev = validateEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
    });
    expect(dev.ok).toBe(true);
    const local = validateEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/thence",
      THENCE_APP_ORIGIN: "http://localhost:3000",
    });
    expect(local.ok).toBe(true);
  });
});
