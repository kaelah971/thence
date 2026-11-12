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
import { canShowCancelUnpaid, matchesFilter, resumeLabelFor, STAGE_OF, timelineFor, type ActivityFilter } from "@/ui/lib/status";
import { canHaveReceipt, getReceipt, getTransfer, humanAmount, toActivityItem } from "@/ui/lib/transfers-api";
import {
  getProviderEvidence,
  needsOwnerClaim,
  postCloseExpired,
  postHandoffCancel,
  EXPIRED_UNFUNDED_BODY,
  postReconcile,
  providerEvidenceDisposition,
  providerStatusLabel,
  type ProviderEvidence,
  type ProviderEvidenceDisposition,
} from "@/ui/lib/settlement-client";
import { invalidateData } from "@/ui/lib/resource";
import { NEW_PAYMENT_HREF } from "@/ui/lib/send-navigation";
import { usePaymentProgress } from "@/ui/screens/send/SettlementProgress";
import styles from "./activity.module.css";
import { ProofFeed } from "./ProofFeed";
import { loadHandoffRecord } from "@/ui/screens/send/useHandoff";
import { preConfirmationRefusalCopy, type PreConfirmationRefusalCopy } from "@/ui/lib/pre-confirmation-refusal";

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

const TERMINAL_DETAIL = new Set(["DELIVERED", "USER_CANCELLED", "QUOTE_EXPIRED", "REFUNDED", "FAILED", "EXPIRED_UNFUNDED"]);
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
  const [checkedNote, setCheckedNote] = useState<string | null>(null);
  const [providerEvidence, setProviderEvidence] = useState<ProviderEvidence | null>(null);
  const [providerEvidenceLoading, setProviderEvidenceLoading] = useState(false);
  const [providerEvidenceError, setProviderEvidenceError] = useState<string | null>(null);
  // Money-moving payments are tracked live by the card below; a manual
  // "Check for updates" next to it only duplicates that.
  const canCheck = !TERMINAL_DETAIL.has(item.status) && !LIVE_PROGRESS_DETAIL.has(item.status) && resource.status !== "loading";
  return (
    <>
      {resource.status === "error" && (
        <Notice tone="warn" icon="info" title="Showing the last known status">
          {resource.message}
        </Notice>
      )}
      {canCheck && (
        <div style={{ marginBottom: 12 }}>
          <Button
            variant="soft"
            size="md"
            icon="refresh"
            block
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setCheckedNote(null);
              void postReconcile(item.id)
                .then((result) => {
                  if (!result.ok && result.kind === "unauthorized") setCheckedNote("Your session has ended. Sign in again.");
                  else if (!result.ok) setCheckedNote("The network check is temporarily unavailable. Try again shortly.");
                  else setCheckedNote("Checked just now. The latest status is shown below.");
                  if ("refresh" in resource) resource.refresh();
                })
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </Button>
          {checkedNote && <p className={styles.latest}>{checkedNote}</p>}
        </div>
      )}
      {userId && TRACKED_DETAIL.has(item.status) && (
        <ActivityClaimRecovery
          transferId={item.id}
          ownerUserId={userId}
          knownStatus={item.status}
          routeId={item.routeId}
          onStatusChange={() => {
            if ("refresh" in resource) resource.refresh();
          }}
        />
      )}
      <ProviderEvidencePanel
        transferId={item.id}
        evidence={providerEvidence}
        loading={providerEvidenceLoading}
        error={providerEvidenceError}
        onCheck={() => {
          setProviderEvidenceLoading(true);
          setProviderEvidenceError(null);
          void getProviderEvidence(item.id)
            .then((result) => {
              if (result.ok) setProviderEvidence(result.data.evidence);
              else {
                setProviderEvidence(null);
                setProviderEvidenceError(result.kind === "unauthorized" ? "Your session has ended. Evidence is UNKNOWN." : "Evidence is unavailable. Funding status is UNKNOWN.");
              }
            })
            .finally(() => setProviderEvidenceLoading(false));
        }}
      />
      <TransferDetail
        item={item}
        preview={false}
        providerEvidence={providerEvidence}
        archived={archived}
        onArchiveChange={onArchiveChange}
        refusal={refusalFor(item.id, userId)}
      />
    </>
  );
}

/** Local, UX-only Nimiq Pay pre-confirmation refusal for this payment (never sent as evidence). */
function refusalFor(transferId: string, ownerUserId: string | null): PreConfirmationRefusalCopy | null {
  const stored = ownerUserId ? loadHandoffRecord(transferId, ownerUserId)?.refusal ?? null : null;
  return stored ? preConfirmationRefusalCopy(stored.reason, stored.invoiceExpiresAt) : null;
}

/** Statuses where money is moving after approval: the live progress card speaks for the payment. */
const LIVE_PROGRESS_DETAIL = new Set(["LIGHTNING_HANDOFF", "CLIENT_FUNDED", "SERVER_FUNDED", "CLAIMING"]);

function ActivityClaimRecovery({
  transferId,
  ownerUserId,
  knownStatus,
  routeId,
  onStatusChange,
}: {
  transferId: string;
  ownerUserId: string;
  knownStatus: string;
  routeId: ActivityItem["routeId"];
  onStatusChange: () => void;
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

  // Before approval the detail below explains the next step; the tracker runs silently.
  const live = LIVE_PROGRESS_DETAIL.has(liveStatus ?? knownStatus) || progress.view?.action === "finish";
  if (!live || !progress.content) return null;

  return (
    <div style={{ marginBottom: 12 }} data-recovery-transfer-id={transferId}>
      {progress.content}
      {progress.action}
    </div>
  );
}

function ProviderEvidencePanel({
  transferId,
  evidence,
  loading,
  error,
  onCheck,
}: {
  transferId: string;
  evidence: ProviderEvidence | null;
  loading: boolean;
  error: string | null;
  onCheck: () => void;
}): React.JSX.Element {
  const disposition: ProviderEvidenceDisposition = providerEvidenceDisposition(evidence);
  const expiry = evidence?.invoiceExpiresAt ? new Date(evidence.invoiceExpiresAt) : null;
  const expiryLabel = !evidence || !expiry || Number.isNaN(expiry.getTime()) ? "UNKNOWN" : evidence.invoiceExpired ? "Expired" : `Live until ${expiry.toLocaleString()}`;
  const tone = disposition === "UNKNOWN" || disposition === "REFUNDED" ? "warn" : "info";
  const title = disposition === "EXPIRED_UNFUNDED"
    ? "Funding evidence: EXPIRED — SAFE TO CLOSE"
    : disposition === "REFUNDED"
      ? "Funding evidence: REFUNDED — NO DELIVERY"
      : `Funding evidence: ${disposition}`;
  return (
    <div style={{ marginBottom: 12 }} data-transfer-id={transferId}>
      <Button variant="soft" size="md" icon="refresh" block disabled={loading} onClick={onCheck}>
        {loading ? "Checking payment status…" : "Check payment status"}
      </Button>
      {error && (
        <Notice tone="warn" icon="alert" title="Funding evidence: UNKNOWN" live>
          {error}
        </Notice>
      )}
      {evidence && (
        <Notice tone={tone} icon={disposition === "UNKNOWN" || disposition === "REFUNDED" ? "alert" : "info"} title={title} live>
          <dl className={styles.facts}>
            <div><dt>Provider status</dt><dd>{providerStatusLabel(evidence.providerStatus)}</dd></div>
            <div><dt>Invoice expiry</dt><dd>{expiryLabel}</dd></div>
            <div><dt>Swap identity</dt><dd>{evidence.identityMatch ? "MATCH" : "MISMATCH — UNKNOWN"}</dd></div>
            <div><dt>Funding transaction</dt><dd>{evidence.hasEvmFundingTx ? "Present" : "Not reported"}</dd></div>
            <div><dt>{disposition === "REFUNDED" ? "Refund transaction" : "Claim transaction"}</dt><dd>{evidence.hasEvmClaimTx ? "Present" : "Not reported"}</dd></div>
          </dl>
          {disposition === "UNKNOWN" && <p className={styles.latest}>Invoice expiry alone is not proof that funding did not happen.</p>}
          {disposition === "REFUNDED" && <p className={styles.latest}>The provider reports that its Polygon lock was refunded to the provider. That is not a refund of your NIM. Do not claim or start another payment; keep this payment open for reconciliation.</p>}
          {disposition === "EXPIRED_UNFUNDED" && <p className={styles.latest}>Satora reports this swap expired without funding. The server will re-check that evidence before closing it.</p>}
        </Notice>
      )}
    </div>
  );
}

function TransferDetail({
  item,
  preview,
  providerEvidence = null,
  archived = false,
  onArchiveChange,
  refusal = null,
}: {
  item: ActivityItem;
  preview: boolean;
  providerEvidence?: ProviderEvidence | null;
  archived?: boolean;
  onArchiveChange?: (archived: boolean) => void;
  refusal?: PreConfirmationRefusalCopy | null;
}): React.JSX.Element {
  const destination = destinationFor(item.routeId);
  const stage = STAGE_OF[item.status];
  const [closing, setClosing] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const evidenceDisposition = providerEvidenceDisposition(providerEvidence);
  // The server re-verifies every close. A fresh, identity-matched Satora
  // `expired` result is the only post-approval close affordance; funding and
  // uncertain evidence stay open.
  const canRetire = !preview && canShowCancelUnpaid(item.status, evidenceDisposition === "EXPIRED_UNFUNDED");
  // P4: an authorized payment stuck in "checking" whose fresh provider
  // evidence says it expired unfunded. The server re-proves everything
  // (including an independent chain scan) before closing.
  const canCloseExpired = !preview && item.status === "RECONCILING" && evidenceDisposition === "EXPIRED_UNFUNDED";
  const [closedExpired, setClosedExpired] = useState(false);
  // The server's re-check outranks the provider read: once a close is refused
  // (e.g. network activity found), stop saying no money moved and restore the
  // "do not resend" warning. The button stays so a transient refusal can retry.
  const [closeRefused, setCloseRefused] = useState(false);
  const expiredClaimShown = canCloseExpired && !closeRefused;
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

      {expiredClaimShown && !closedExpired && (
        <Notice tone="info" icon="info" title="This payment expired before any money moved">
          The provider reports this payment expired without being funded. You can close it — Thence checks the provider and the
          network again first, and keeps it open if anything doesn&apos;t match.
        </Notice>
      )}
      {(item.status === "EXPIRED_UNFUNDED" || closedExpired) && (
        <Notice tone="info" icon="info" title="Payment expired — not delivered">
          {EXPIRED_UNFUNDED_BODY}
        </Notice>
      )}
      {stage === "checking" && !expiredClaimShown && !closedExpired && (
        // Provider evidence of funding/settlement/refund always outranks the client's account.
        refusal && evidenceDisposition === "UNKNOWN" ? (
          <Notice tone="warn" icon="alert" title={refusal.title}>
            {refusal.body}
          </Notice>
        ) : (
          <Notice tone="warn" icon="clock" title="Checking your payment — do not resend">
            We can&apos;t confirm the outcome yet. Starting another payment could pay them twice.
          </Notice>
        )
      )}
      {stage === "attention" && (
        <Notice tone="error" icon="alert" title="Needs your attention">
          Follow the next step before starting another payment.
        </Notice>
      )}
      {stage === "approval" && (
        <Notice tone="info" icon="info" title="Approve in Nimiq Pay">
          Nimiq Pay shows the exact NIM debit before you confirm.
        </Notice>
      )}
      {((stage === "moving" && preview) || stage === "ready") && (
        <Notice tone="info" icon="clock" title={stage === "moving" ? "Payment in progress" : "Ready to continue"}>
          {stage === "moving"
            ? "Thence is still checking this payment. A receipt appears once delivery is confirmed on their network."
            : "No approval is recorded for this payment yet. You can continue where you left off."}
        </Notice>
      )}
      {!preview && resumeLabelFor(item.status) !== null && evidenceDisposition !== "EXPIRED_UNFUNDED" && (
        <div style={{ marginTop: 12 }}>
          <ButtonLink href={`/app/send?resume=${item.id}`} variant="ink" size="md" icon="arrow-right" block>
            {resumeLabelFor(item.status)}
          </ButtonLink>
          <p className={styles.latest}>Continues the same payment — never starts a new one.</p>
        </div>
      )}
      {canCloseExpired && !closedExpired && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant="soft"
            size="md"
            icon="close"
            block
            disabled={closing}
            onClick={() => {
              setClosing(true);
              setClosedNote(null);
              void postCloseExpired(item.id)
                .then((result) => {
                  if (result.ok && result.data.resolution.status === "EXPIRED_UNFUNDED") {
                    setClosedExpired(true);
                    setClosedNote("Closed. Nothing reached their network, and the payment is no longer counted as in progress.");
                    invalidateData();
                    return;
                  }
                  setCloseRefused(true);
                  if (!result.ok && result.kind === "unauthorized") {
                    setClosedNote("Your session has ended. Sign in again.");
                  } else if (!result.ok && result.message) {
                    setClosedNote(result.message);
                  } else {
                    setClosedNote("We couldn't close it right now. It stays open — don't resend.");
                  }
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
      {closedExpired && closedNote && <p className={styles.latest}>{closedNote}</p>}
      {canRetire && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant="soft"
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

      <div className={styles.timelineCard}>
        <div className={styles.timelineHead}>
          <p className={styles.timelineTitle}>Progress</p>
          {item.statusLabel && !LIVE_PROGRESS_DETAIL.has(item.status) && <p className={styles.latest}>Latest: {item.statusLabel}</p>}
        </div>
        <Timeline steps={timelineFor(item.status)} />
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

/** Loaded only for DELIVERED transfers; the server confirms the proof. */
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
  return (
    <div className={styles.receipt}>
      <div className={styles.receiptHead}>
        <Icon name="receipt" size={18} />
        <p>Receipt</p>
      </div>
      <dl className={styles.receiptRows}>
        <div>
          <dt>They received</dt>
          <dd className="tabular">{received ? `${received} ${receipt.asset}` : "—"}</dd>
        </div>
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
