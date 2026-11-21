"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ButtonLink, Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, FilterChips, Notice, PreviewTag, Skeleton, StatusPill } from "@/ui/components/primitives";
import { ActivityRow, formatReceive, RowSkeletons, type ActivityItem } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { Timeline } from "@/ui/components/Timeline";
import { destinationFor, maskAddress } from "@/ui/lib/assets";
import { loadActivityArchive, setActivityArchived } from "@/ui/lib/activity-archive";
import { useActivityData } from "@/ui/lib/data";
import { useApiResource } from "@/ui/lib/resource";
import { useSession } from "@/ui/lib/session";
import { canShowCancelUnpaid, matchesFilter, resumeLabelFor, timelineFor, type ActivityFilter } from "@/ui/lib/status";
import { canHaveReceipt, getReceipt, getTransfer, humanAmount, shortReceiptAmounts, toActivityItem } from "@/ui/lib/transfers-api";
import {
  getProviderEvidence,
  needsOwnerClaim,
  postCloseExpired,
  postCloseNimReturned,
  postHandoffCancel,
  EXPIRED_UNFUNDED_BODY,
  expiredNimReturnedBody,
  postReconcile,
  providerEvidenceDisposition,
  providerStatusLabel,
  type ProviderEvidence,
} from "@/ui/lib/settlement-client";
import { friendlyMessage } from "@/ui/lib/api";
import { recoveryState, type RecoveryView } from "@/ui/lib/recovery-state";
import { invalidateData } from "@/ui/lib/resource";
import { NEW_PAYMENT_HREF } from "@/ui/lib/send-navigation";
import { usePaymentProgress } from "@/ui/screens/send/SettlementProgress";
import styles from "./activity.module.css";
import { ProofFeed } from "./ProofFeed";
import { settlementNetworkFor } from "@/ui/lib/network-copy";

const FILTERS: ReadonlyArray<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "progress", label: "In progress" },
  { value: "delivered", label: "Delivered" },
  { value: "attention", label: "Needs attention" },
  { value: "archived", label: "Archived" },
];

type ActivityView = "mine" | "proofs";

const VIEWS: ReadonlyArray<{ value: ActivityView; title: string; sub: string; icon: "user" | "globe" }> = [
  { value: "mine", title: "My activity", sub: "Your payments", icon: "user" },
  { value: "proofs", title: "Proof feed", sub: "Global payments", icon: "globe" },
];

/** A3c.2: My activity | Proof feed — a two-option radio group styled as the approved segmented toggle. */
function ViewToggle({ value, onChange }: { value: ActivityView; onChange: (next: ActivityView) => void }): React.JSX.Element {
  const index = Math.max(0, VIEWS.findIndex((v) => v.value === value));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
    const next = VIEWS[nextIndex];
    if (!next) return;
    onChange(next.value);
    const group = event.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div role="radiogroup" aria-label="Activity view" className={styles.viewToggle} onKeyDown={onKeyDown}>
      <span aria-hidden="true" className={styles.viewThumb} style={{ transform: `translateX(${index * 100}%)` }} />
      {VIEWS.map((view) => {
        const selected = view.value === value;
        return (
          <button
            key={view.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={styles.viewOption}
            onClick={() => onChange(view.value)}
          >
            <Icon name={view.icon} size={22} strokeWidth={1.8} />
            <span className={styles.viewText}>
              <span className={styles.viewTitle}>{view.title}</span>
              <span className={styles.viewSub}>{view.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Activity(): React.JSX.Element {
  const [view, setView] = useState<ActivityView>("mine");
  const data = useActivityData();
  const session = useSession();
  const ownerUserId = session.status === "valid" ? session.me.user.id : null;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<ActivityItem | null>(null);
  const [archiveVersion, setArchiveVersion] = useState(0);
  const archivedIds = useMemo(() => {
    void archiveVersion;
    return loadActivityArchive(ownerUserId);
  }, [ownerUserId, archiveVersion]);

  const showingArchived = filter === "archived";
  const items = data.status === "ready"
    ? data.items.filter((i) => (archivedIds.has(i.id) === showingArchived) && (showingArchived || matchesFilter(i.status, filter)))
    : [];
  const groups = items.reduce<Array<{ day: string; items: ActivityItem[] }>>((acc, item) => {
    const day = item.dayLabel || "Recent";
    const group = acc.find((g) => g.day === day);
    if (group) group.items.push(item);
    else acc.push({ day, items: [item] });
    return acc;
  }, []);
  const inProgress = data.status === "ready" ? data.items.filter((i) => matchesFilter(i.status, "progress")).length : 0;
  const noPaymentsAtAll = data.status === "ready" && data.items.length === 0;
  const preview = data.status === "ready" && data.preview;

  return (
    <main className={shell.screen}>
      <section className={shell.darkTop}>
        <span className={shell.glow} aria-hidden="true" />
        <h1 className={shell.title}>Activity</h1>
        <p className={styles.lede}>Track your payments and see delivered proof.</p>
        <div className={styles.newPayment}>
          <ButtonLink href={NEW_PAYMENT_HREF} variant="mint" size="md" icon="arrow-up-right">
            New payment
          </ButtonLink>
        </div>
        <div className={styles.summary}>
          <div className={styles.summaryTile}>
            <Icon name="clock" size={18} />
            <p className={styles.summaryValue}>{data.status === "ready" ? inProgress : "—"}</p>
            <p className={styles.summaryLabel}>In progress</p>
          </div>
          <div className={styles.summaryTile}>
            <Icon name="shield" size={18} />
            <p className={styles.summaryText}>Delivered only appears once it&apos;s confirmed on their network.</p>
          </div>
        </div>
        <ViewToggle value={view} onChange={setView} />
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />
        {view === "proofs" ? (
          <ProofFeed onShowMine={() => setView("mine")} />
        ) : (
          <>
            {preview && (
              <div className={styles.previewRow}>
                <PreviewTag>Preview payments · fictional, nothing was sent</PreviewTag>
              </div>
            )}
            {!noPaymentsAtAll && <FilterChips label="Filter payments" options={FILTERS} value={filter} onChange={setFilter} />}

            {data.status === "loading" && <RowSkeletons count={4} />}
            {data.status === "error" && (
              <EmptyState
                icon="alert"
                title="Couldn't load your activity"
                body={data.message}
                action={
                  <Button variant="soft" size="md" icon="refresh" onClick={data.retry}>
                    Try again
                  </Button>
                }
              />
            )}
            {(data.status === "disconnected" || noPaymentsAtAll) && (
              <EmptyState
                icon="activity"
                title="No payments yet"
                body="Payments you send show up here, with each step until they're delivered."
                action={
                  <ButtonLink href={NEW_PAYMENT_HREF} variant="ink" size="md" icon="arrow-up-right">
                    Send money
                  </ButtonLink>
                }
              />
            )}
            {data.status === "ready" &&
              !noPaymentsAtAll &&
              (groups.length === 0 ? (
                <EmptyState
                  icon="filter"
                  title="Nothing here"
                  body="No payments match this filter."
                  action={
                    <Button variant="soft" size="md" onClick={() => setFilter("all")}>
                      Show all payments
                    </Button>
                  }
                />
              ) : (
                <div aria-busy={data.refreshing}>
                  {groups.map((group) => (
                    <section key={group.day} className={styles.group} aria-label={group.day}>
                      <h2 className={styles.day}>{group.day}</h2>
                      {group.items.map((item) => (
                        <ActivityRow key={item.id} item={item} showDay={false} onSelect={() => setSelected(item)} />
                      ))}
                    </section>
                  ))}
                  {data.hasMore && (
                    <div className={styles.more}>
                      <Button variant="soft" size="md" onClick={data.loadMore}>
                        Show older payments
                      </Button>
                    </div>
                  )}
                </div>
              ))}
          </>
        )}
      </section>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title="Payment details">
        {selected && (preview ? (
          <TransferDetail item={selected} preview />
        ) : (
          <LiveTransferDetail
            key={selected.id}
            initial={selected}
            archived={archivedIds.has(selected.id)}
            onArchiveChange={(archived) => {
              setActivityArchived(ownerUserId, selected.id, archived);
              setArchiveVersion((version) => version + 1);
              setSelected(null);
            }}
          />
        ))}
      </Sheet>
    </main>
  );
}

/**
 * P3: the shared tracker runs for every in-flight payment opened in Activity,
 * so funding that lands while the sheet is open surfaces Finish delivery at
 * once (Nov 2: the action only mounted if the row was already funded).
 */
const TRACKED_DETAIL = new Set(["AWAITING_NIM_APPROVAL", "LIGHTNING_HANDOFF", "OUTCOME_UNKNOWN", "RECONCILING", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]);
const FUNDED_DETAIL = new Set(["SERVER_FUNDED", "CLAIMING"]);

/** Re-reads the transfer so the sheet shows the latest server status. */
function LiveTransferDetail({
  initial,
  archived,
  onArchiveChange,
}: {
  initial: ActivityItem;
  archived: boolean;
  onArchiveChange: (archived: boolean) => void;
}): React.JSX.Element {
  const session = useSession();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const resource = useApiResource(userId ? `transfer:${userId}:${initial.id}` : null, (signal) => getTransfer(initial.id, { signal }));
  const fresh = resource.status === "ready" ? toActivityItem(resource.data.transfer) : null;
  const item = fresh ?? initial;
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [providerEvidence, setProviderEvidence] = useState<ProviderEvidence | null>(null);
  const [live, setLive] = useState<LiveFacts>({ sourceVerified: false, action: null });
  // ONE status check (it replaces "Check for updates" + "Check payment status",
  // which each ran half of this): the server reconciles first (it may advance
  // the payment), then a fresh provider read refreshes the evidence and the
  // server's close-gate preview. A failed read clears old evidence, so a stale
  // read can never keep a close action on screen.
  const checkStatus = () => {
    if (checking) return;
    setChecking(true);
    setCheckNote(null);
    void (async () => {
      const reconciled = await postReconcile(item.id);
      if (!reconciled.ok && reconciled.kind === "unauthorized") {
        setCheckNote("Your session has ended. Sign in again.");
        return;
      }
      if ("refresh" in resource) resource.refresh();
      const evidence = await getProviderEvidence(item.id);
      setProviderEvidence(evidence.ok ? evidence.data.evidence : null);
      if (!reconciled.ok && reconciled.kind === "rate-limited") setCheckNote(friendlyMessage(reconciled));
      else if (!evidence.ok && evidence.kind === "rate-limited") setCheckNote(friendlyMessage(evidence));
      else if (!evidence.ok && evidence.code === "NOT_RECONCILABLE") setCheckNote("No provider swap is linked to this payment yet, so there is nothing more to check.");
      else if (!evidence.ok || !reconciled.ok) setCheckNote("Part of the check is temporarily unavailable. The payment stays as shown — don't pay again. Try again shortly.");
      else setCheckNote("Checked just now.");
    })().finally(() => setChecking(false));
  };
  return (
    <>
      {resource.status === "error" && (
        <Notice tone="warn" icon="info" title="Showing the last known status">
          {resource.message}
        </Notice>
      )}
      {userId && TRACKED_DETAIL.has(item.status) && (
        <ActivityClaimRecovery
          transferId={item.id}
          ownerUserId={userId}
          knownStatus={item.status}
          routeId={item.routeId}
          onLive={setLive}
          onStatusChange={() => {
            if ("refresh" in resource) resource.refresh();
          }}
        />
      )}
      <TransferDetail
        item={item}
        preview={false}
        providerEvidence={providerEvidence}
        live={live}
        statusCheck={{ run: checkStatus, checking, note: checkNote }}
        archived={archived}
        onArchiveChange={onArchiveChange}
      />
    </>
  );
}

/** What the live tracker knows that the list row doesn't (server facts only). */
interface LiveFacts {
  sourceVerified: boolean;
  /** The live card's own next action ("check" means it waits on the single status check). */
  action: string | null;
}

/** Statuses where money is moving after approval: the live progress card speaks for the payment. */
const LIVE_PROGRESS_DETAIL = new Set(["LIGHTNING_HANDOFF", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]);

function ActivityClaimRecovery({
  transferId,
  ownerUserId,
  knownStatus,
  routeId,
  onStatusChange,
  onLive,
}: {
  transferId: string;
  ownerUserId: string;
  knownStatus: string;
  routeId: ActivityItem["routeId"];
  onStatusChange: () => void;
  onLive: (facts: LiveFacts) => void;
}): React.JSX.Element | null {
  // Same single view as the Send screen (status, deadline, ONE action); the
  // detail below already shows the timeline and receipt, so compact here.
  const progress = usePaymentProgress({
    transferId,
    ownerUserId,
    requestPublicId: null,
    sessionValid: true,
    previewMode: false,
    routeId,
    asset: destinationFor(routeId).asset,
    saveOffer: null,
    compact: true,
  });
  const liveStatus = progress.transferStatus;

  // Keep the detail sheet's own status in step with the live tracker.
  useEffect(() => {
    if (liveStatus && liveStatus !== knownStatus) onStatusChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStatus]);
  const liveAction = progress.view?.action ?? null;
  useEffect(() => {
    onLive({ sourceVerified: progress.sourceVerified, action: liveAction });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.sourceVerified, liveAction]);

  // Before approval the detail below explains the next step; the tracker runs silently.
  const live = LIVE_PROGRESS_DETAIL.has(liveStatus ?? knownStatus) || progress.view?.action === "finish";
  if (!live || !progress.content) return null;

  return (
    <div style={{ marginBottom: 12 }} data-recovery-transfer-id={transferId}>
      {progress.content}
      {/* Finish delivery only: the sheet's single "Check payment status" replaces the card's own check. */}
      {liveAction === "check" ? null : progress.action}
    </div>
  );
}

/** Facts from the latest provider read. The recovery card says what they mean. */
function ProviderEvidenceFacts({ evidence }: { evidence: ProviderEvidence }): React.JSX.Element {
  const expiry = evidence.invoiceExpiresAt ? new Date(evidence.invoiceExpiresAt) : null;
  const expiryLabel = !expiry || Number.isNaN(expiry.getTime()) ? "Unknown" : evidence.invoiceExpired ? "Expired" : `Live until ${expiry.toLocaleString()}`;
  const disposition = providerEvidenceDisposition(evidence);
  return (
    <div className={styles.timelineCard} data-provider-evidence={disposition}>
      <div className={styles.timelineHead}>
        <p className={styles.timelineTitle}>Latest provider check</p>
      </div>
      <dl className={styles.facts}>
        <div><dt>Provider status</dt><dd>{providerStatusLabel(evidence.providerStatus)}</dd></div>
        <div><dt>Invoice expiry</dt><dd>{expiryLabel}</dd></div>
        <div><dt>Swap identity</dt><dd>{evidence.identityMatch ? "Matches this payment" : "Doesn't match — kept open"}</dd></div>
        <div><dt>Funding transaction</dt><dd>{evidence.hasEvmFundingTx ? "Reported" : "Not reported"}</dd></div>
        <div><dt>Claim transaction</dt><dd>{evidence.hasEvmClaimTx ? "Reported" : "Not reported"}</dd></div>
      </dl>
      {evidence.invoiceExpired && disposition === "UNKNOWN" && <p className={styles.latest}>Invoice expiry alone is not proof that funding did not happen.</p>}
    </div>
  );
}

function RecoveryCard({ view }: { view: RecoveryView }): React.JSX.Element {
  return (
    <div data-recovery-kind={view.kind} data-recovery-primary={view.primary}>
      <Notice tone={view.tone === "warn" ? "warn" : "info"} icon={view.tone === "warn" ? "alert" : view.kind === "uncertain" ? "clock" : "info"} title={view.title}>
        {view.body}
      </Notice>
    </div>
  );
}

function TransferDetail({
  item,
  preview,
  providerEvidence = null,
  live = null,
  statusCheck = null,
  archived = false,
  onArchiveChange,
}: {
  item: ActivityItem;
  preview: boolean;
  providerEvidence?: ProviderEvidence | null;
  live?: LiveFacts | null;
  /** The single status check (server reconcile + fresh provider read); absent in preview. */
  statusCheck?: { run: () => void; checking: boolean; note: string | null } | null;
  archived?: boolean;
  onArchiveChange?: (archived: boolean) => void;
}): React.JSX.Element {
  const destination = destinationFor(item.routeId);
  const [closing, setClosing] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [closedExpired, setClosedExpired] = useState(false);
  // The server's close re-check outranks its own earlier preview: once a close
  // is refused (e.g. network activity found), the close gate is treated as
  // refused with the server's reason until the owner checks again.
  const [closeRefusal, setCloseRefusal] = useState<{ evidence: ProviderEvidence; reason: string | null; message: string } | null>(null);
  const evidence: ProviderEvidence | null =
    providerEvidence && closeRefusal?.evidence === providerEvidence && providerEvidence.closeEligibility
      ? {
          ...providerEvidence,
          closeEligibility: {
            ...providerEvidence.closeEligibility,
            expiredUnfunded: { eligible: false, reason: closeRefusal.reason, message: closeRefusal.message },
          },
        }
      : providerEvidence;
  const evidenceDisposition = providerEvidenceDisposition(evidence);
  // ONE classification, ONE primary action. Close actions surface only from the
  // server's close-gate preview; the actions themselves re-verify everything.
  const recovery = recoveryState({ status: item.status, evidence, sourceVerified: live?.sourceVerified === true, readOnly: preview, network: settlementNetworkFor(item.routeId) });
  const canRetire = !preview && canShowCancelUnpaid(item.status, evidenceDisposition === "EXPIRED_UNFUNDED");
  const canCloseExpired = !preview && recovery.primary === "close-expired";
  // R2: a failed Lightning handoff whose NIM was locked. The server proves the
  // NIM return on-chain before closing; nothing here claims a refund.
  const [returnedResult, setReturnedResult] = useState<{ refundTxHash: string; returnedLuna: string; feeLuna: string } | null>(null);
  const [returnNote, setReturnNote] = useState<string | null>(null);
  const [checkingReturn, setCheckingReturn] = useState(false);
  const canCloseReturned = !preview && returnedResult === null && recovery.primary === "check-nim-return";
  const verifiedReturn = returnedResult ?? (item.status === "EXPIRED_UNFUNDED" ? (item.nimReturn ?? null) : null);
  const closedNow = closedExpired || verifiedReturn !== null;
  // The live progress card already speaks for a payment that is moving; the
  // recovery card speaks for everything else (and for an eligible close).
  const liveCovers = !preview && LIVE_PROGRESS_DETAIL.has(item.status) && recovery.kind !== "expired-closable";
  const showRecoveryCard = !closedNow && !liveCovers && (recovery.kind !== "closed" || item.status === "FAILED");
  // The single status check: primary while the outcome is uncertain; secondary
  // while waiting for approval (an expired swap can then be cancelled), and
  // when the live card is waiting on a check.
  const showStatusCheck =
    !preview &&
    statusCheck !== null &&
    !closedNow &&
    (recovery.primary === "check-status" || (recovery.kind === "funds-moved" && live?.action === "check") || item.status === "AWAITING_NIM_APPROVAL");
  return (
    <div className={styles.detail}>
      <div className={styles.detailHero}>
        <Avatar name={item.name} tone={item.tone} size={56} />
        <p className={styles.detailWho}>{item.name} receives</p>
        <p className={styles.detailAmount}>{formatReceive(item.amount, item.routeId)}</p>
        <p className={styles.detailNet}>
          <AssetMark asset={destination.asset} size={16} /> on {destination.network} · {item.dayLabel}, {item.timeLabel}
        </p>
        <div className={styles.detailStatus}>
          <StatusPill status={item.status} />
          {preview && <PreviewTag />}
        </div>
      </div>

      {!preview && onArchiveChange && (
        <div style={{ marginBottom: 12 }}>
          <Button variant="soft" size="md" icon={archived ? "refresh" : "close"} block onClick={() => onArchiveChange(!archived)}>
            {archived ? "Show in Activity" : "Hide from Activity"}
          </Button>
          <p className={styles.latest}>
            This only changes your Activity view. It does not cancel the payment, release exposure, or confirm settlement.
          </p>
        </div>
      )}

      {showRecoveryCard && <RecoveryCard view={recovery} />}
      {verifiedReturn ? (
        <Notice tone="info" icon="info" title="Not delivered — NIM return verified on the Nimiq blockchain">
          {expiredNimReturnedBody(verifiedReturn)}
        </Notice>
      ) : (
        (item.status === "EXPIRED_UNFUNDED" || closedExpired) && (
          <Notice tone="info" icon="info" title="Payment expired — not delivered">
            {EXPIRED_UNFUNDED_BODY}
          </Notice>
        )
      )}

      {canCloseExpired && !closedExpired && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant="ink"
            size="md"
            icon="close"
            block
            disabled={closing}
            onClick={() => {
              setClosing(true);
              setClosedNote(null);
              const readAt = providerEvidence;
              void postCloseExpired(item.id)
                .then((result) => {
                  if (result.ok && result.data.resolution.status === "EXPIRED_UNFUNDED") {
                    setClosedExpired(true);
                    setClosedNote("Closed. Nothing reached their network, and the payment is no longer counted as in progress.");
                    invalidateData();
                    return;
                  }
                  const message =
                    !result.ok && result.kind === "unauthorized"
                      ? "Your session has ended. Sign in again."
                      : !result.ok && result.message
                        ? result.message
                        : "We couldn't close it right now. It stays open — don't resend.";
                  if (readAt) setCloseRefusal({ evidence: readAt, reason: !result.ok ? result.code : null, message });
                  setClosedNote(message);
                  invalidateData();
                })
                .finally(() => setClosing(false));
            }}
          >
            {closing ? "Checking before closing…" : "Close expired payment"}
          </Button>
          <p className={styles.latest}>{closedNote ?? "History is kept. This never sends or refunds money."}</p>
        </div>
      )}
      {/* A refusal's reason is shown once, inside the recovery card. */}
      {closedExpired && closedNote && (
        <p className={styles.latest} role="status">
          {closedNote}
        </p>
      )}

      {canCloseReturned && (
        <div style={{ marginTop: 12 }} data-nim-return-close>
          <Button
            variant="ink"
            size="md"
            icon="refresh"
            block
            disabled={checkingReturn}
            onClick={() => {
              setCheckingReturn(true);
              setReturnNote(null);
              void postCloseNimReturned(item.id)
                .then((result) => {
                  if (result.ok && result.data.resolution.status === "EXPIRED_UNFUNDED" && result.data.resolution.nimReturn) {
                    setReturnedResult(result.data.resolution.nimReturn);
                    invalidateData();
                    return;
                  }
                  if (!result.ok && result.kind === "unauthorized") setReturnNote("Your session has ended. Sign in again.");
                  else if (!result.ok && result.message) setReturnNote(result.message);
                  else setReturnNote("Thence couldn't confirm your NIM came back yet. The payment stays open — don't pay again.");
                })
                .finally(() => setCheckingReturn(false));
            }}
          >
            {checkingReturn ? "Checking the Nimiq blockchain…" : "Check whether my NIM was returned"}
          </Button>
          {returnNote && (
            <p className={styles.latest} role="status">
              {returnNote}
            </p>
          )}
        </div>
      )}

      {!preview && recovery.primary === "resume" && resumeLabelFor(item.status) !== null && (
        <div style={{ marginTop: 12 }}>
          <ButtonLink href={`/app/send?resume=${item.id}`} variant="ink" size="md" icon="arrow-right" block>
            {resumeLabelFor(item.status)}
          </ButtonLink>
          <p className={styles.latest}>Continues the same payment — never starts a new one.</p>
        </div>
      )}

      {showStatusCheck && statusCheck && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant={recovery.primary === "check-status" ? "ink" : "soft"}
            size="md"
            icon="refresh"
            block
            disabled={statusCheck.checking}
            onClick={statusCheck.run}
          >
            {statusCheck.checking ? "Checking payment status…" : "Check payment status"}
          </Button>
          <p className={styles.latest} role="status">
            {statusCheck.note ?? "Asks the provider and the network again. It never sends, closes or refunds anything."}
          </p>
        </div>
      )}

      {/* The check's outcome (e.g. rate limiting) stays visible even when it surfaced a different action. */}
      {!showStatusCheck && statusCheck?.note && !closedNow && (
        <p className={styles.latest} role="status">
          {statusCheck.note}
        </p>
      )}

      {canRetire && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant={recovery.primary === "cancel-unpaid" ? "ink" : "soft"}
            size="md"
            icon="close"
            block
            disabled={closing}
            onClick={() => {
              setClosing(true);
              setClosedNote(null);
              void postHandoffCancel(item.id)
                .then(async (result) => {
                  if (!result.ok && result.kind === "unauthorized") {
                    setClosedNote("Your session has ended. Sign in again.");
                    return;
                  }
                  if (!result.ok && result.kind === "network") {
                    // The response was lost: the server may still have closed
                    // it. Re-read authoritative state instead of guessing — a
                    // blind success must surface as closed, never as failure.
                    const fresh = await getTransfer(item.id).catch(() => null);
                    if (fresh === null || !fresh.ok) {
                      setClosedNote("Could not safely cancel it. The payment outcome is still unknown; check Activity before starting another.");
                      invalidateData();
                      return;
                    }
                    const freshItem = toActivityItem(fresh.data.transfer);
                    if (freshItem !== null && freshItem.status === "USER_CANCELLED") {
                      setClosedNote("Cancelled safely. The server confirmed no payment was approved or funded.");
                    } else {
                      setClosedNote("Could not safely cancel it. The payment outcome is still unknown; check Activity before starting another.");
                    }
                    invalidateData();
                    return;
                  }
                  if (!result.ok) setClosedNote("Could not safely cancel it. The payment outcome is still unknown; check Activity before starting another.");
                  else if (result.data.handoff.status === "USER_CANCELLED") setClosedNote("Cancelled safely. The server confirmed no payment was approved or funded.");
                  else setClosedNote("Still open. The payment outcome is unknown; do not resend.");
                  invalidateData();
                })
                .finally(() => setClosing(false));
            }}
          >
            {closing ? "Cancelling…" : "Cancel unpaid payment"}
          </Button>
          {closedNote ? (
            <p className={styles.latest}>{closedNote}</p>
          ) : evidenceDisposition === "EXPIRED_UNFUNDED" ? (
            <p className={styles.latest}>Provider evidence shows the swap expired without funding. History is kept.</p>
          ) : (
            <p className={styles.latest}>Only for payments that never reached approval. History is kept.</p>
          )}
        </div>
      )}

      {!preview && evidence && !closedNow && recovery.kind !== "closed" && <ProviderEvidenceFacts evidence={evidence} />}

      <div className={styles.timelineCard}>
        <div className={styles.timelineHead}>
          <p className={styles.timelineTitle}>Progress</p>
          {item.statusLabel && !LIVE_PROGRESS_DETAIL.has(item.status) && <p className={styles.latest}>Latest: {item.statusLabel}</p>}
        </div>
        <Timeline steps={timelineFor(item.status, { network: settlementNetworkFor(item.routeId), desk: item.quoteProvider === "desk" || item.status.startsWith("DESK_") })} />
      </div>

      {item.destination && (
        <dl className={styles.facts}>
          <div>
            <dt>Sent to</dt>
            <dd className={styles.mono}>{maskAddress(item.destination)}</dd>
          </div>
        </dl>
      )}

      {canHaveReceipt(item.status) && (preview ? <PreviewReceipt item={item} /> : <LiveReceipt item={item} />)}
    </div>
  );
}

/** Loaded only for DELIVERED / DELIVERED_SHORT transfers; the server confirms the proof. */
function LiveReceipt({ item }: { item: ActivityItem }): React.JSX.Element {
  const session = useSession();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const resource = useApiResource(userId ? `receipt:${userId}:${item.id}` : null, (signal) => getReceipt(item.id, { signal }));

  if (resource.status === "loading" || resource.status === "idle") {
    return (
      <div className={styles.receipt} aria-busy="true">
        <Skeleton width="40%" height={14} />
        <Skeleton width="100%" height={60} />
      </div>
    );
  }
  if (resource.status === "error") {
    return (
      <Notice tone="info" icon="receipt" title="Receipt not available yet">
        The delivery proof is still being put together. Check back shortly.
      </Notice>
    );
  }
  const receipt = resource.data.receipt;
  const received = humanAmount(receipt.verifiedAmountAtomic, receipt.asset);
  const short = shortReceiptAmounts(receipt);
  return (
    <div className={styles.receipt}>
      <div className={styles.receiptHead}>
        <Icon name="receipt" size={18} />
        <p>{short ? "Receipt — less than requested" : "Receipt"}</p>
      </div>
      <dl className={styles.receiptRows}>
        {short && (
          <div>
            <dt>You asked to send</dt>
            <dd className="tabular">{`${short.requested} ${receipt.asset}`}</dd>
          </div>
        )}
        <div>
          <dt>They received</dt>
          <dd className="tabular">{received ? `${received} ${receipt.asset}` : "—"}</dd>
        </div>
        {short && (
          <div>
            <dt>Short by</dt>
            <dd className="tabular">{`${short.short} ${receipt.asset}`}</dd>
          </div>
        )}
        <div>
          <dt>Network</dt>
          <dd>{receipt.network}</dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd className={styles.mono}>{maskAddress(receipt.destination)}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>{new Date(receipt.verifiedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </div>
        <div>
          <dt>Payment proof</dt>
          <dd>
            <a href={receipt.explorerTxUrl} target="_blank" rel="noopener noreferrer" className={styles.proofLink}>
              View on {receipt.network}
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PreviewReceipt({ item }: { item: ActivityItem }): React.JSX.Element {
  const destination = destinationFor(item.routeId);
  return (
    <div className={styles.receipt}>
      <div className={styles.receiptHead}>
        <Icon name="receipt" size={18} />
        <p>Receipt</p>
        <PreviewTag />
      </div>
      <dl className={styles.receiptRows}>
        <div>
          <dt>They received</dt>
          <dd className="tabular">{formatReceive(item.amount, item.routeId)}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{destination.network}</dd>
        </div>
        <div>
          <dt>Payment proof</dt>
          <dd className={styles.muted}>Shown for real, verified payments</dd>
        </div>
      </dl>
    </div>
  );
}
