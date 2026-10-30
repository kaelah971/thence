import { redirect } from "next/navigation";

/**
 * Root route: server-side redirect to the real Thence application at /app.
 * Replaces the old B0 backend placeholder (see app/app/page.tsx EntryGate).
 */
export default function Home(): never {
  redirect("/app");
}
