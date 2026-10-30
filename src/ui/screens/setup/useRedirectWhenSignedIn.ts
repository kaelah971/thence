"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isOnboarded, useSession } from "@/ui/lib/session";

/** A valid session never needs the connect screens again. */
export function useRedirectWhenSignedIn(): void {
  const router = useRouter();
  const session = useSession();
  const target = session.status !== "valid" ? null : isOnboarded(session) ? "/app/home" : "/app/setup/name";
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
}
