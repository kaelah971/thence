import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { SESSION_COOKIE_NAME, getAuthenticatedSession } from "@/lib/auth";
import { isDiagnosticsOwner } from "@/lib/diagnostics";
import { StorageDiagnostic } from "@/ui/screens/diagnostics/StorageDiagnostic";

export const metadata: Metadata = { title: "Storage check", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Owner-only iOS WebView storage diagnostic (no money).
 *
 * - Signed in as a non-owner → 404.
 * - Signed in as an owner → the diagnostic.
 * - Signed out → a shell that shows results only if THIS device already holds
 *   diagnostic markers from an owner run (losing the login cookie is one of
 *   the outcomes being measured); otherwise "Not available". It can start
 *   nothing: the API refuses every write without an owner session.
 */
export default async function StorageDiagnosticPage(): Promise<React.JSX.Element> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  let session = null;
  try {
    session = await getAuthenticatedSession(token ? decodeURIComponent(token) : null);
  } catch {
    session = null;
  }
  if (session && !isDiagnosticsOwner(session.nimiqAddress)) notFound();
  return <StorageDiagnostic ownerAtRender={session !== null} />;
}
