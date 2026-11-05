"use client";

/**
 * Owner-only entry to the storage diagnostic. Asks the server once when the
 * wallet sheet opens; renders nothing unless the server confirms an owner
 * session (non-owners get 404 and see nothing).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { DIAG_API } from "@/ui/lib/storage-diagnostic";

export const DIAGNOSTICS_HREF = "/app/diagnostics/storage";

export function DiagnosticsLink({ className, doFetch }: { className?: string | undefined; doFetch?: typeof fetch | undefined }): React.JSX.Element | null {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    let alive = true;
    const run = doFetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    run(DIAG_API, { credentials: "same-origin", cache: "no-store" })
      .then((res) => {
        if (alive && res.status === 200) setOwner(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [doFetch]);
  if (!owner) return null;
  return (
    <Link href={DIAGNOSTICS_HREF} className={className}>
      Storage diagnostic (owner, no money)
    </Link>
  );
}
