import type { NextConfig } from "next";

/**
 * Build identity for on-device verification (F8.13): Vercel provides the
 * deployed commit as VERCEL_GIT_COMMIT_SHA at build time. Expose a short
 * non-sensitive prefix to the client bundle so the iPhone app itself can
 * show which release is actually running (no more guessing from deploy
 * dashboards). Local builds fall back to "local".
 */
if (!process.env.NEXT_PUBLIC_THENCE_BUILD_REF) {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  process.env.NEXT_PUBLIC_THENCE_BUILD_REF = sha.length >= 7 ? sha.slice(0, 7) : "local";
}

/**
 * P7: the browser E2E builds into its own directory (`.next-e2e`) with the
 * payment/claim flags on, so it can never overwrite or be mistaken for the
 * release build in `.next` (flags off). Unset everywhere else.
 */
const distDir = (process.env.THENCE_NEXT_DIST_DIR ?? "").trim();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(distDir === ".next-e2e" ? { distDir } : {}),
};

export default nextConfig;
