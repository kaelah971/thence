/**
 * Thence backend — typed configuration and safe environment validation (B0).
 *
 * Rules:
 * - Never log or return secret values.
 * - Provider contract addresses are environment-specific and verified,
 *   never guessed or hard-coded (see src/domain/routes.ts).
 * - Wallet authentication (B1) must not be implemented here; this module
 *   only validates configuration shape.
 */
import { z } from "zod";

/** `0x` EVM address shape — validated, never guessed. */
const evmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex EVM address");

/**
 * Optional per-route token map supplied ONLY via environment.
 * Empty = unverified = route stays non-quoteable. This is intentional:
 * B0 must not invent production contract addresses.
 *
 * Format: JSON object, e.g. {"usdt-polygon":"0x...","usdc-base":"0x..."}
 */
const routeTokenMapSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return {} as Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object" });
        return z.NEVER;
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `token for "${k}" must be a 0x-prefixed 40-hex EVM address`,
          });
          return z.NEVER;
        }
        out[k] = v;
      }
      return out;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
      return z.NEVER;
    }
  });

/**
 * Optional per-chain trusted EVM RPC map, ONLY via environment.
 * Empty = chain verification unavailable (fail-closed, never public RPCs).
 * Format: JSON object, e.g. {"1":"https://...","137":"https://..."}
 */
const evmRpcMapSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return {} as Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object" });
        return z.NEVER;
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^\d+$/.test(k)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `chain id "${k}" must be numeric` });
          return z.NEVER;
        }
        if (typeof v !== "string" || !/^https:\/\/[^\s]+$/i.test(v)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `RPC for chain "${k}" must be an https URL` });
          return z.NEVER;
        }
        out[k] = v;
      }
      return out;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
      return z.NEVER;
    }
  });

/**
 * Optional per-chain finality overrides. Empty = documented defaults.
 * Format: {"137": {"mode": "confirmations", "confirmations": 256}}
 * Modes: "finalized" (receipt block must be at or below the RPC's
 * finalized block) or "confirmations" (latest - receipt + 1 >= N).
 */
const finalityMapSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return {} as Record<string, { mode: string; confirmations: number }>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object" });
        return z.NEVER;
      }
      const out: Record<string, { mode: string; confirmations: number }> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!/^\d+$/.test(k)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `chain id "${k}" must be numeric` });
          return z.NEVER;
        }
        const e = v as Record<string, unknown>;
        if (e["mode"] !== "finalized" && e["mode"] !== "confirmations") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `finality for chain "${k}" must use mode "finalized" or "confirmations"` });
          return z.NEVER;
        }
        const n = e["mode"] === "confirmations" ? e["confirmations"] : 1;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `confirmations for chain "${k}" must be a positive integer` });
          return z.NEVER;
        }
        out[k] = { mode: e["mode"] as string, confirmations: n };
      }
      return out;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => v.startsWith("postgresql://") || v.startsWith("postgres://"), {
      message: "DATABASE_URL must be a postgresql:// connection string",
    }),
  APP_VERSION: z.string().default("0.1.0-b0"),
  /** Comma-separated list of enabled route ids, e.g. "usdt-polygon,usdc-base". Empty = none enabled. */
  THENCE_ENABLED_ROUTES: z.string().default(""),
  /** Verified token addresses per route id (see above). Empty = none verified. */
  THENCE_ROUTE_TOKENS_JSON: routeTokenMapSchema,
  /** Quote validity window in seconds. */
  THENCE_QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Wallet-login challenge lifetime in seconds (B1). */
  THENCE_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Session lifetime in seconds (B1). */
  THENCE_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
  /** Fixed-window rate limits per minute per client key (B1, DB-backed). */
  THENCE_CHALLENGE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  THENCE_VERIFY_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /**
   * Global abuse ceiling per minute, shared across all anonymous callers
   * (B5.2, DB-backed). Backstop for endpoints without a server-derived
   * identity: never the primary control, but bounds aggregate issuance
   * when forwarded headers are forged. Edge rate limiting / WAF remains
   * the production control (see docs/OPERATIONS.md).
   */
  THENCE_ANON_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(600),
  /** Per-challenge verify-attempt cap (B5.2): rotating IPs cannot retry one challenge beyond this. */
  THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE: z.coerce.number().int().positive().default(10),
  /** Per-token verification-submission cap (B5.2): bounds retries against one verification token. */
  THENCE_VERIFY_ATTEMPTS_PER_TOKEN: z.coerce.number().int().positive().default(10),
  /** Write rate limit for recipient/destination endpoints (B2.1, DB-backed). */
  THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Default payment-request lifetime in seconds (B2.2). */
  THENCE_REQUEST_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  /** Maximum payment-request lifetime in seconds (B2.2). */
  THENCE_REQUEST_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(90 * 24 * 3600),
  /** Public request-read rate limit per minute per client (B2.2, DB-backed). */
  THENCE_REQUESTS_READ_RATE_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Recipient-verification challenge lifetime in seconds (B2.3). */
  THENCE_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Verification-endpoint rate limit per minute per client (B2.3, DB-backed). */
  THENCE_VERIFICATION_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Quote-endpoint rate limit per minute per client (B3.1, DB-backed). */
  THENCE_QUOTES_RATE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /** Transfer-endpoint write rate limit per minute per client (B4.1, DB-backed). */
  THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Transfer read rate limit per minute per client (B4.3, DB-backed). */
  THENCE_TRANSFERS_READ_RATE_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Handoff preparation lifetime in seconds (B4.2). */
  THENCE_PREPARATION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Optional override for the Satora API base URL (B3.1). Empty = SDK default. */
  THENCE_SATORA_BASE_URL: z.string().default(""),
  /** Trusted EVM RPC endpoints per chain id (B4.4). Empty = chain verification unavailable. */
  THENCE_EVM_RPCS_JSON: evmRpcMapSchema,
  /** Per-chain finality policy overrides (B4.4). Empty = documented defaults. */
  THENCE_SETTLEMENT_FINALITY_JSON: finalityMapSchema,
  /**
   * Trusted Nimiq JSON-RPC endpoint for read-only balance display (F6).
   * Empty = server balance read unavailable (fail-closed; the host read
   * through Nimiq Pay still works where the host supports it).
   */
  THENCE_NIMIQ_RPC_URL: z
    .string()
    .default("")
    .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), { message: "must be empty or an https URL" }),
  /** Nimiq network the RPC above serves. Used to refuse cross-network balances. */
  THENCE_NIMIQ_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  /** Trusted application origin for absolute share links, e.g. https://pay.thence.example. Empty = relative links only. */
  THENCE_APP_ORIGIN: z
    .string()
    .default("")
    .refine((v) => v === "" || /^https?:\/\/[^/\s]+\/?$/i.test(v), {
      message: "must be empty or a bare http(s) origin without path",
    }),
  /** Extra allowed Origins (comma-separated) for cookie-authenticated POSTs. Empty = same-origin only. */
  THENCE_ALLOWED_ORIGINS: z.string().default(""),
}).superRefine((val, ctx) => {
  // Production share-link safety (Slice 0 C5): absolute request links are
  // built from THENCE_APP_ORIGIN. In production the origin must be an
  // explicit https origin — never missing, localhost or loopback — so a
  // dev .env can never leak http://localhost links to hosted users.
  // Development/test keep existing behaviour (empty = relative links).
  if (val.NODE_ENV !== "production") return;
  const raw = (val.THENCE_APP_ORIGIN ?? "").trim();
  if (!raw) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "is required in production (set THENCE_APP_ORIGIN to your https origin)",
      path: ["THENCE_APP_ORIGIN"],
    });
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid https origin in production",
      path: ["THENCE_APP_ORIGIN"],
    });
    return;
  }
  if (url.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be an https origin in production",
      path: ["THENCE_APP_ORIGIN"],
    });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLocalhost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
  const isLoopback =
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host === "::1";
  if (isLocalhost || isLoopback) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must not be localhost or a loopback address in production",
      path: ["THENCE_APP_ORIGIN"],
    });
  }
});

export type ThenceEnv = z.infer<typeof envSchema>;

export type EnvValidationResult =
  | { ok: true; env: ThenceEnv }
  | { ok: false; issues: z.ZodIssue[] };

/**
 * Validate an arbitrary record (defaults to process.env).
 * Never throws for missing optional config; reports issues structurally
 * so callers/tests can assert without leaking values.
 */
export function validateEnv(source: Record<string, string | undefined> = process.env): EnvValidationResult {
  const parsed = envSchema.safeParse({
    NODE_ENV: source["NODE_ENV"],
    DATABASE_URL: source["DATABASE_URL"],
    APP_VERSION: source["APP_VERSION"],
    THENCE_ENABLED_ROUTES: source["THENCE_ENABLED_ROUTES"],
    THENCE_ROUTE_TOKENS_JSON: source["THENCE_ROUTE_TOKENS_JSON"],
    THENCE_QUOTE_TTL_SECONDS: source["THENCE_QUOTE_TTL_SECONDS"],
    THENCE_CHALLENGE_TTL_SECONDS: source["THENCE_CHALLENGE_TTL_SECONDS"],
    THENCE_SESSION_TTL_SECONDS: source["THENCE_SESSION_TTL_SECONDS"],
    THENCE_CHALLENGE_RATE_PER_MINUTE: source["THENCE_CHALLENGE_RATE_PER_MINUTE"],
    THENCE_VERIFY_RATE_PER_MINUTE: source["THENCE_VERIFY_RATE_PER_MINUTE"],
    THENCE_ANON_GLOBAL_PER_MINUTE: source["THENCE_ANON_GLOBAL_PER_MINUTE"],
    THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE: source["THENCE_VERIFY_ATTEMPTS_PER_CHALLENGE"],
    THENCE_VERIFY_ATTEMPTS_PER_TOKEN: source["THENCE_VERIFY_ATTEMPTS_PER_TOKEN"],
    THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE: source["THENCE_RECIPIENTS_WRITE_RATE_PER_MINUTE"],
    THENCE_VERIFICATION_TTL_SECONDS: source["THENCE_VERIFICATION_TTL_SECONDS"],
    THENCE_VERIFICATION_RATE_PER_MINUTE: source["THENCE_VERIFICATION_RATE_PER_MINUTE"],
    THENCE_QUOTES_RATE_PER_MINUTE: source["THENCE_QUOTES_RATE_PER_MINUTE"],
    THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE: source["THENCE_TRANSFERS_WRITE_RATE_PER_MINUTE"],
    THENCE_TRANSFERS_READ_RATE_PER_MINUTE: source["THENCE_TRANSFERS_READ_RATE_PER_MINUTE"],
    THENCE_PREPARATION_TTL_SECONDS: source["THENCE_PREPARATION_TTL_SECONDS"],
    THENCE_SATORA_BASE_URL: source["THENCE_SATORA_BASE_URL"],
    THENCE_EVM_RPCS_JSON: source["THENCE_EVM_RPCS_JSON"],
    THENCE_SETTLEMENT_FINALITY_JSON: source["THENCE_SETTLEMENT_FINALITY_JSON"],
    THENCE_NIMIQ_RPC_URL: source["THENCE_NIMIQ_RPC_URL"],
    THENCE_NIMIQ_NETWORK: source["THENCE_NIMIQ_NETWORK"],
    THENCE_REQUEST_DEFAULT_TTL_SECONDS: source["THENCE_REQUEST_DEFAULT_TTL_SECONDS"],
    THENCE_REQUEST_MAX_TTL_SECONDS: source["THENCE_REQUEST_MAX_TTL_SECONDS"],
    THENCE_REQUESTS_READ_RATE_PER_MINUTE: source["THENCE_REQUESTS_READ_RATE_PER_MINUTE"],
    THENCE_APP_ORIGIN: source["THENCE_APP_ORIGIN"],
    THENCE_ALLOWED_ORIGINS: source["THENCE_ALLOWED_ORIGINS"],
  });
  if (parsed.success) return { ok: true, env: parsed.data };
  return { ok: false, issues: parsed.error.issues };
}

/** Names of secret-bearing variables — safe diagnostics must never include their values. */
export const SECRET_ENV_KEYS = ["DATABASE_URL", "CRON_SECRET"] as const;

/**
 * Get validated config, throwing a value-free error when invalid.
 * The thrown message contains field names only, never credential material.
 */
export function getEnv(source: Record<string, string | undefined> = process.env): ThenceEnv {
  const result = validateEnv(source);
  if (!result.ok) {
    const fields = result.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.env;
}

/** Parse the enabled-route list into a clean string array. */
export function parseEnabledRoutes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export { evmAddressSchema };
