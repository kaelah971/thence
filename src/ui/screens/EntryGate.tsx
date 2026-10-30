"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui/components/Button";
import { ThenceMark } from "@/ui/components/ThenceMark";
import { resolveEntry } from "@/ui/lib/entry";
import { isOnboarded, refreshSession, useSession } from "@/ui/lib/session";
import { useIntroSeen } from "@/ui/lib/stores";
import styles from "./screens.module.css";

/**
 * Decides the first screen from the real backend session (GET /api/me)
 * plus the device's intro hint:
 *   valid + onboarded → Home · valid, not onboarded → name
 *   expired → reconnect · none → tour (first visit) or reconnect
 */
export function EntryGate(): React.JSX.Element {
  const router = useRouter();
  const introSeen = useIntroSeen();
  const session = useSession();

  useEffect(() => {
    if (introSeen === undefined || session.status === "unknown" || session.status === "error") return;
    router.replace(resolveEntry({ session: session.status, profileOnboarded: isOnboarded(session), introSeenHint: introSeen }));
  }, [introSeen, session, router]);

  return (
    <main className={styles.splash} aria-busy={session.status !== "error"}>
      <ThenceMark size={44} />
      {session.status === "error" ? (
        <div className={styles.splashError} role="alert">
          <p>Thence couldn&apos;t reach its server.</p>
          <Button variant="dark" size="md" onClick={() => void refreshSession()}>
            Try again
          </Button>
        </div>
      ) : (
        <span className="sr-only">Opening Thence…</span>
      )}
    </main>
  );
}
