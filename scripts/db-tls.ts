/**
 * R4 — certificate-verified TLS for operator script connections.
 *
 * Remote databases always connect with `ssl: { rejectUnauthorized: true }`,
 * verified against Node's trusted CA store (Neon serves a publicly trusted
 * certificate). TLS parameters in the URL (`sslmode`, `sslrootcert`, …) are
 * removed, because pg lets connection-string TLS settings override `ssl` and
 * `sslmode=no-verify` would silently disable verification. Credentials,
 * host and database are untouched. Localhost uses no TLS.
 */
import { isLocalhostTarget } from "./db-guard";

const TLS_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslcrl", "uselibpqcompat"];

export function verifiedClientConfig(url: string): { connectionString: string; ssl: { rejectUnauthorized: true } | undefined } {
  if (isLocalhostTarget(url)) return { connectionString: url, ssl: undefined };
  const parsed = new URL(url);
  for (const p of TLS_PARAMS) parsed.searchParams.delete(p);
  return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: true } };
}
