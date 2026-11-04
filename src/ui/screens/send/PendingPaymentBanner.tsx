"use client";

import { Button, ButtonLink } from "@/ui/components/Button";
import { Notice } from "@/ui/components/primitives";
import { pendingBannerAction } from "@/ui/lib/prepare-flow";
import styles from "./send.module.css";

/**
 * Send-screen banner for a saved, unfinished payment pointer.
 *
 * Offers "Continue" ONLY for states the preparation flow can resume on the
 * same transfer. Anything in flight or being checked (e.g. a RECONCILING
 * payment) shows its real state and "View in Activity" instead — Activity
 * owns the gated actions (Finish delivery within a verified deadline).
 * Purely presentational: never clears the pointer, never creates anything;
 * the server re-checks every action regardless.
 */
export type PendingBannerState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; transferStatus: string; statusLabel: string | null };

const CONTINUE_LABEL: Record<string, string> = {
  QUOTED: "Resume payment",
  SWAP_CREATED: "Resume payment",
  AWAITING_NIM_APPROVAL: "Continue to approval",
};

export function PendingPaymentBanner({ state, onContinue }: { state: PendingBannerState; onContinue: () => void }): React.JSX.Element | null {
  if (state.status === "loading") {
    return (
      <div className={styles.requestNotice}>
        <Notice tone="dark" icon="clock" title="You have an unfinished payment">
          Checking its status…
        </Notice>
      </div>
    );
  }
  const action = state.status === "ready" ? pendingBannerAction(state.transferStatus) : "activity";
  if (action === "finished") return null;
  if (action === "continue" && state.status === "ready") {
    return (
      <div className={styles.requestNotice}>
        <Notice tone="dark" icon="clock" title="Continue an interrupted payment">
          You started a payment that hasn&apos;t finished preparing. Its outcome is not confirmed; check Activity before continuing.
        </Notice>
        <div style={{ marginTop: 8 }}>
          <Button variant="soft" size="md" icon="arrow-right" block onClick={onContinue}>
            {CONTINUE_LABEL[state.transferStatus] ?? "Continue payment"}
          </Button>
        </div>
      </div>
    );
  }
  const label = state.status === "ready" ? state.statusLabel : null;
  return (
    <div className={styles.requestNotice}>
      <Notice tone="dark" icon="clock" title={label ?? "An earlier payment is still being checked"}>
        This payment can&apos;t be continued from here — don&apos;t send it again. Open Activity to see its status and any action it needs, such as Finish
        delivery.
      </Notice>
      <div style={{ marginTop: 8 }}>
        <ButtonLink href="/app/activity" variant="soft" size="md" icon="arrow-right" block>
          View in Activity
        </ButtonLink>
      </div>
    </div>
  );
}
