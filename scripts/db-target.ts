/**
 * S0/R4 — shared database-target parsing (pure: no connections, no TLS).
 *
 * WHY this lives apart from `db-guard.ts`: the guard must itself connect with
 * certificate-verified TLS (`scripts/db-tls.ts`), and the verified client
 * config needs the localhost rule. Importing the rule from `db-guard.ts` while
 * the guard imported the client config back would create a cycle. The shared
 * primitives therefore live here, and `db-guard.ts` re-exports them so every
 * existing importer keeps working.
 *
 * Identity only: host/port/database (role ignored, Neon pooler normalized).
 * Nothing here reads the environment or opens a socket.
 */

export interface DbTarget {
  /** Role (user). Informational only; never part of the identity comparison. */
  user: string;
  /** Lower-cased host with any Neon `-pooler` suffix removed from the endpoint label. */
  host: string;
  port: string;
  database: string;
}

/** Strip the Neon pooler suffix: `ep-x-123-pooler.region…` and `ep-x-123.region…` are one database. */
export function normalizeDbHost(hostname: string): string {
  const host = hostname.toLowerCase();
  const [first, ...rest] = host.split(".");
  if (!first) return host;
  return [first.replace(/-pooler$/, ""), ...rest].join(".");
}

/** Parse a postgres connection string into non-secret identity components. Null when unparseable. */
export function parseDbTarget(url: string): DbTarget | null {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    const database = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!parsed.hostname || !database) return null;
    return {
      user: decodeURIComponent(parsed.username),
      host: normalizeDbHost(parsed.hostname),
      port: parsed.port || "5432",
      database,
    };
  } catch {
    return null;
  }
}

/** True when both URLs address the same database (role ignored, pooler normalized). Unparseable → false. */
export function sameDatabase(a: string, b: string): boolean {
  const x = parseDbTarget(a);
  const y = parseDbTarget(b);
  if (!x || !y) return false;
  return x.host === y.host && x.port === y.port && x.database === y.database;
}

export function isLocalhostTarget(url: string): boolean {
  const target = parseDbTarget(url);
  if (!target) return false;
  return target.host === "localhost" || target.host === "127.0.0.1" || target.host === "::1" || target.host === "[::1]";
}
