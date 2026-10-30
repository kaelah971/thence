"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/ui/lib/session";
import { usePreviewState } from "@/ui/lib/stores";

/**
 * App tabs require a valid backend session. Without one, hand off to the
 * entry gate (/app), which shows the tour or the short reconnect screen.
 * Development preview renders fixtures only; it never calls an
 * authenticated API and never stands in for a session.
 */
export function SessionGuard({ children }: { children: ReactNode }): React.JSX.Element {
  const router = useRouter();
  const session = useSession();
  const preview = usePreviewState();
  const mustLeave = preview === false && (session.status === "none" || session.status === "expired");

  useEffect(() => {
    if (mustLeave) router.replace("/app");
  }, [mustLeave, router]);

  return <>{mustLeave ? null : children}</>;
}
