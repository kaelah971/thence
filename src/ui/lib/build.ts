/**
 * Build identity shown in the app so a device can prove which release it
 * runs (F8.13). Set at build time from VERCEL_GIT_COMMIT_SHA via
 * next.config.ts; "local" for dev builds. Non-sensitive: a short commit
 * prefix reveals no code, data, or credentials.
 */
export function buildId(env: Record<string, string | undefined> = process.env): string {
  const raw = (env["NEXT_PUBLIC_THENCE_BUILD_REF"] ?? "").trim();
  return raw === "" ? "local" : raw;
}
