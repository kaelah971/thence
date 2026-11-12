"use client";

import { useEffect, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { Skeleton, TextField } from "@/ui/components/primitives";
import { addPerson } from "@/ui/lib/recipient-actions";
import { Timeline } from "@/ui/components/Timeline";
import { maskAddress } from "@/ui/lib/assets";
import { humanAmount } from "@/ui/lib/transfers-api";
import { paymentProgress, type ProgressView } from "@/ui/lib/payment-progress";
import { claimActionAllowed } from "@/domain/claim-deadline";
import type { RouteId } from "@/domain/routes";
import { useSettlement } from "./useSettlement";
import { loadHandoffRecord } from "./useHandoff";
import { preConfirmationRefusalCopy } from "@/ui/lib/pre-confirmation-refusal";
import { ClaimDeadlineLine, useClaimWindow } from "@/ui/components/ClaimDeadline";
import styles from "./send.module.css";

export interface SettlementProgressProps {
  transferId: string | null;
  ownerUserId: string | null;
  requestPublicId: string | null;
  sessionValid: boolean;
  previewMode: boolean;
  routeId: RouteId;
  asset: string;
  /** One-off payee worth offering to save; null when N/A. Shown on the delivered receipt only. */
  saveOffer: { address: string; routeId: RouteId } | null;
  /** Status, deadline and action only — for screens that already show the timeline and receipt (Activity). */
  compact?: boolean;
  /** Nimiq Pay was already asked for this payment in this browser. */
  handedOff?: boolean;
}

export interface PaymentProgressParts {
  /** Status card + the ONE timeline + receipt (null before tracking starts). */
  content: React.ReactNode;
  /** The ONE contextual next action (Finish delivery / Check again), or null. */
  action: React.ReactNode;
  view: ProgressView | null;
  /** Server status as last read (null until the first read). */
  transferStatus: string | null;
}

/**
 * F4.3/P3 — honest payment progress for a prepared transfer, as ONE view.
 *
 * Read-only tracking starts on mount (shared tracker, visibility-aware,
 * cleaned up on unmount). "Delivered" renders only with the backend-confirmed
 * immutable receipt — never from approval, funding, claim or broadcast. The
 * Finish delivery control stays behind every existing gate: server
 * claimReady, the client-clock claim window, the claim-pending record and
 * the server claim lease (useSettlement.attemptClaim).
 */
export function usePaymentProgress({
  transferId,
  ownerUserId,
  requestPublicId,
  sessionValid,
  previewMode,
  asset,
  saveOffer,
  compact = false,
  handedOff = false,
}: SettlementProgressProps): PaymentProgressParts {
  const settlement = useSettlement();
  const [claiming, setClaiming] = useState(false);
  const state = settlement.state;

  useEffect(() => {
    if (transferId && ownerUserId) {
      void settlement.track({ transferId, ownerUserId, sessionValid, previewMode });
    }
    return () => settlement.stop();
    // Track once per transfer; the shared tracker wakes itself on foreground.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId, ownerUserId]);

  const { window } = useClaimWindow(state.claimDeadlineMs ?? null);
  const tracking = Boolean(transferId && ownerUserId) && state.phase !== "idle";
  // Local, UX-only explanation of a Nimiq Pay pre-confirmation refusal (never sent as evidence).
  const stored = transferId && ownerUserId ? loadHandoffRecord(transferId, ownerUserId)?.refusal ?? null : null;
  const refusal = stored ? preConfirmationRefusalCopy(stored.reason, stored.invoiceExpiresAt) : null;
  const view = tracking
    ? paymentProgress({
        phase: state.phase,
        transferStatus: state.transferStatus,
        providerStatus: state.providerStatus,
        claimReady: state.claimReady,
        claimPending: state.claimPending === true,
        identityMismatch: state.identityMismatch === true,
        verifyVerdict: state.verifyVerdict,
        receiptReady: state.receipt !== null,
        message: state.message,
        handedOff,
        refusal,
      })
    : null;
  const finishNeeded = view?.action === "finish" && !previewMode && Boolean(ownerUserId);
  // Both clocks must agree: the server's claimReady AND the local deadline window.
  const finishAvailable = finishNeeded && state.claimReady && claimActionAllowed(window);

  const startClaim = () => {
    if (!transferId || !ownerUserId || claiming) return;
    setClaiming(true);
    void settlement
      .attemptClaim({ transferId, ownerUserId, sessionValid, previewMode, explicitClaimAuthorization: true })
      .finally(() => setClaiming(false));
  };

  const content = !tracking ? null : (
    <div className={styles.progress} data-progress-action={view?.action} data-tone={view?.tone}>
      <div className={styles.progressCard} role="status" aria-live="polite">
        <span className={styles.progressIcon} aria-hidden="true">
          {view?.action === "wait" || view?.action === "verifying" ? (
            <span className={styles.quoteSpinner} />
          ) : (
            <Icon name={view?.tone === "done" ? "check" : view?.tone === "action" || view?.tone === "warn" ? "alert" : "clock"} size={18} strokeWidth={2.6} />
          )}
        </span>
        <div>
          <p className={styles.progressHeadline}>{view?.headline}</p>
          {view?.body ? <p className={styles.progressBody}>{view.body}</p> : null}
        </div>
      </div>

      {finishNeeded && <ClaimDeadlineLine deadlineMs={state.claimDeadlineMs ?? null} className={styles.deadline} />}
      {finishNeeded && !finishAvailable && claimActionAllowed(window) && (
        <p className={styles.ctaNote} data-finish-pending>
          <span className={styles.quoteSpinner} aria-hidden="true" /> Getting Finish delivery ready — the button appears here in a moment.
        </p>
      )}

      {claiming && state.claimMessage?.startsWith("Securing the payment on Polygon") && (
        <p className={styles.ctaNote} role="status" aria-live="polite" data-claim-waiting>
          <span className={styles.quoteSpinner} aria-hidden="true" /> {state.claimMessage}
        </p>
      )}

      {state.claimMessage && !claiming && view?.action !== "receipt" && !/^Delivery submitted/.test(state.claimMessage) && (
        <p className={styles.ctaNote} role="status" data-claim-result>
          {state.claimMessage}
        </p>
      )}

      {requestPublicId && (
        <p className={styles.ctaNote}>
          <Icon name="lock" size={14} /> Pays request {requestPublicId.slice(0, 8)}… — it counts as paid once delivery is confirmed.
        </p>
      )}

      {!compact && view?.steps && view.action !== "receipt" && (
        <div className={styles.next}>
          <Timeline steps={view.steps} />
        </div>
      )}

      {!compact && state.phase === "delivered" && state.receipt && (
        <div className={styles.receipt}>
          <div className={styles.receiptHead}>
            <Icon name="receipt" size={18} />
            <p>Receipt</p>
          </div>
          <dl className={styles.receiptRows}>
            <div>
              <dt>Recipient</dt>
              <dd>{state.receipt.recipientName?.trim() || "Someone new"}</dd>
            </div>
            <div>
              <dt>They received</dt>
              <dd className="tabular">
                {(() => {
                  const received = humanAmount(state.receipt?.verifiedAmountAtomic ?? "", state.receipt?.asset ?? asset);
                  return received ? `${received} ${state.receipt?.asset}` : "—";
                })()}
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{state.receipt.network}</dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd className={styles.mono}>{maskAddress(state.receipt.destination)}</dd>
            </div>
            <div>
              <dt>Confirmed</dt>
              <dd>{new Date(state.receipt.verifiedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd>
            </div>
            <div>
              <dt>Payment proof</dt>
              <dd>
                <a href={state.receipt.explorerTxUrl} target="_blank" rel="noopener noreferrer" className={styles.proofLink}>
                  View on {state.receipt.network}
                </a>
              </dd>
            </div>
          </dl>
          {state.receipt.actualFundingProven === false && (
            <p className={styles.ctaNote}>The receipt proves what they received. The exact amount debited from you isn&apos;t shown here.</p>
          )}
          {saveOffer !== null && <ReceiptSaveOffer address={saveOffer.address} routeId={saveOffer.routeId} />}
        </div>
      )}

      {!compact && state.phase === "delivered" && !state.receipt && (
        <div className={styles.receipt} aria-busy="true">
          <Skeleton width="40%" height={14} />
          <Skeleton width="100%" height={60} />
        </div>
      )}
    </div>
  );

  let action: React.ReactNode = null;
  if (finishAvailable) {
    action = (
      <Button variant="ink" block icon="arrow-right" disabled={claiming} aria-busy={claiming} onClick={startClaim}>
        {claiming ? "Checking delivery…" : "Finish delivery"}
      </Button>
    );
  } else if (view?.action === "check" && transferId && ownerUserId) {
    action = (
      <Button
        variant="soft"
        icon="refresh"
        block
        onClick={() => {
          void settlement.checkAgain({ transferId, ownerUserId, sessionValid, previewMode });
        }}
      >
        Check again
      </Button>
    );
  }

  return { content, action, view, transferStatus: state.transferStatus };
}

/** Standalone progress (content followed by its action), for screens without a sticky footer. */
export function SettlementProgress(props: SettlementProgressProps): React.JSX.Element {
  const parts = usePaymentProgress(props);
  return (
    <div className={styles.quoteBox}>
      {parts.content ?? (
        <p className={styles.quoteLine} role="status" aria-live="polite">
          <span className={styles.quoteSpinner} aria-hidden="true" /> Checking your payment
        </p>
      )}
      {parts.action}
    </div>
  );
}

function ReceiptSaveOffer({ address, routeId }: { address: string; routeId: RouteId }): React.JSX.Element {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) {
    return (
      <p className={styles.quoteLine} data-tone="ok">
        <Icon name="check" size={14} strokeWidth={2.6} /> Saved to your recipients.
      </p>
    );
  }
  const issue = !name.trim() ? "Add a nickname to save this recipient." : null;
  return (
    <div>
      <p className={styles.quoteLine}>Want to keep this wallet for next time?</p>
      <TextField
        label="Nickname (required to save)"
        value={name}
        onChange={(event) => {
          setName(event.target.value.slice(0, 120));
          setError(null);
        }}
        onBlur={() => setTouched(true)}
        placeholder="e.g. Alex Moreno"
        autoComplete="off"
        autoCapitalize="words"
        error={(touched ? issue : null) ?? error}
      />
      <Button
        variant="soft"
        block
        disabled={saving}
        aria-busy={saving}
        onClick={() => {
          setTouched(true);
          if (issue || saving) return;
          setSaving(true);
          setError(null);
          void addPerson({ name: name.trim(), routeId, address }, null).then(({ error: saveError }) => {
            setSaving(false);
            if (saveError) {
              setError(saveError.field === "address" ? saveError.message : "Couldn't save this recipient. You can still pay them again any time.");
              return;
            }
            setDone(true);
          });
        }}
      >
        {saving ? "Saving…" : "Save recipient"}
      </Button>
    </div>
  );
}
