"use client";

import { useEffect, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Notice, Skeleton, TextField } from "@/ui/components/primitives";
import { addPerson } from "@/ui/lib/recipient-actions";
import { Timeline } from "@/ui/components/Timeline";
import { destinationFor, maskAddress } from "@/ui/lib/assets";
import { humanAmount } from "@/ui/lib/transfers-api";
import { progressCopy } from "@/ui/lib/settlement-client";
import { timelineFor } from "@/ui/lib/status";
import type { RouteId } from "@/domain/routes";
import { useSettlement } from "./useSettlement";
import styles from "./send.module.css";

/**
 * F4.3 — honest payment progress for a prepared transfer.
 *
 * Read-only tracking starts on mount (bounded, visibility-aware, cleaned
 * up on unmount). "Delivered" renders only with the backend-confirmed
 * immutable receipt — never from invoice, funding, claim or broadcast.
 * The claim control stays behind the owner/session/recovery claim gate.
 */
export function SettlementProgress({
  transferId,
  ownerUserId,
  requestPublicId,
  sessionValid,
  previewMode,
  routeId,
  asset,
  saveOffer,
}: {
  transferId: string;
  ownerUserId: string | null;
  requestPublicId: string | null;
  sessionValid: boolean;
  previewMode: boolean;
  routeId: RouteId;
  asset: string;
  /** One-off payee worth offering to save; null when N/A. Shown on the delivered receipt only. */
  saveOffer: { address: string; routeId: RouteId } | null;
}): React.JSX.Element {
  const settlement = useSettlement();
  const [claiming, setClaiming] = useState(false);
  const state = settlement.state;

  useEffect(() => {
    if (transferId && ownerUserId) {
      void settlement.track({ transferId, ownerUserId, sessionValid, previewMode });
    }
    return () => settlement.stop();
    // Track once per transfer; manual refresh via Check again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId, ownerUserId]);

  const destination = destinationFor(routeId);
  const phase = state.phase === "idle" ? ("checking" as const) : state.phase;
  const title = state.phase === "idle" ? "Checking your payment" : progressCopy(phase).title;
  const message =
    state.phase === "idle" ? "Checking your payment — do not resend." : state.message || progressCopy(phase).body;

  const showClaim =
    (state.phase === "on-its-way" || state.phase === "finishing") && state.claimReady && ownerUserId && !previewMode;
  const showCheckAgain = state.phase === "checking" || state.phase === "attention";

  return (
    <div className={styles.quoteBox}>
      <p className={styles.quoteLine} role="status" aria-live="polite">
        {state.phase === "checking" || state.phase === "idle" ? (
          <span className={styles.quoteSpinner} aria-hidden="true" />
        ) : (
          <Icon name={state.phase === "delivered" ? "check" : state.phase === "attention" ? "alert" : "clock"} size={14} strokeWidth={2.6} />
        )}{" "}
        {title}
      </p>
      <Notice
        tone={state.phase === "attention" ? "warn" : state.phase === "delivered" ? "info" : "info"}
        icon={state.phase === "delivered" ? "check" : state.phase === "attention" ? "alert" : "clock"}
        title={title}
        live
      >
        {message}
      </Notice>

      {requestPublicId && (
        <p className={styles.ctaNote}>
          <Icon name="lock" size={14} /> Pays request {requestPublicId.slice(0, 8)}… — the amount stays locked to the request. It counts as paid only
          once delivery below is confirmed.
        </p>
      )}

      {state.transferStatus && (
        <div className={styles.next}>
          <Timeline steps={timelineFor(state.transferStatus as never)} />
        </div>
      )}

      {showClaim && (
        <>
          <Button
            variant="soft"
            size="md"
            icon="arrow-right"
            block
            disabled={claiming}
            aria-busy={claiming}
            onClick={() => {
              if (!ownerUserId || claiming) return;
              setClaiming(true);
              void settlement
                .attemptClaim({ transferId, ownerUserId, sessionValid, previewMode, explicitClaimAuthorization: true })
                .finally(() => setClaiming(false));
            }}
          >
            {claiming ? "Checking delivery…" : "Finish delivery"}
          </Button>
          <p className={styles.ctaNote}>
            <Icon name="lock" size={14} /> One explicit attempt only. If the result is unclear, wait for Activity to verify it before trying again.
          </p>
        </>
      )}

      {showCheckAgain && ownerUserId && (
        <Button
          variant="soft"
          size="md"
          icon="refresh"
          block
          onClick={() => {
            void settlement.checkAgain({ transferId, ownerUserId, sessionValid, previewMode });
          }}
        >
          Check again
        </Button>
      )}

      {state.phase === "delivered" && state.receipt && (
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

      {state.phase === "delivered" && !state.receipt && (
        <div className={styles.receipt} aria-busy="true">
          <Skeleton width="40%" height={14} />
          <Skeleton width="100%" height={60} />
        </div>
      )}
      {state.phase !== "idle" && state.phase !== "delivered" && state.phase !== "refunded" && (
        <p className={styles.ctaNote}>
          <AssetMark asset={destination.asset} size={14} /> {destination.network} · Checking payment — do not resend.
        </p>
      )}
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
