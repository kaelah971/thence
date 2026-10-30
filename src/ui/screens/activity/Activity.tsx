"use client";

import { useState } from "react";
import { ButtonLink, Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { Avatar, EmptyState, FilterChips, Notice, PreviewTag, Skeleton, StatusPill } from "@/ui/components/primitives";
import { ActivityRow, formatReceive, RowSkeletons, type ActivityItem } from "@/ui/components/rows";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { Timeline } from "@/ui/components/Timeline";
import { destinationFor, maskAddress } from "@/ui/lib/assets";
import { useActivityData } from "@/ui/lib/data";
import { useApiResource } from "@/ui/lib/resource";
import { useSession } from "@/ui/lib/session";
import { matchesFilter, STAGE_OF, timelineFor, type ActivityFilter } from "@/ui/lib/status";
import { canHaveReceipt, getReceipt, getTransfer, humanAmount, toActivityItem } from "@/ui/lib/transfers-api";
import { postReconcile } from "@/ui/lib/settlement-client";
import styles from "./activity.module.css";

const FILTERS: ReadonlyArray<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "progress", label: "In progress" },
  { value: "delivered", label: "Delivered" },
  { value: "attention", label: "Needs attention" },
];

export function Activity(): React.JSX.Element {
  const data = useActivityData();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<ActivityItem | null>(null);

  const items = data.status === "ready" ? data.items.filter((i) => matchesFilter(i.status, filter)) : [];
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
        <p className={styles.lede}>Every payment, from approval to delivery.</p>
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
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />
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
              <ButtonLink href="/app/send" variant="ink" size="md" icon="arrow-up-right">
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
      </section>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title="Payment details">
        {selected && (preview ? <TransferDetail item={selected} preview /> : <LiveTransferDetail key={selected.id} initial={selected} />)}
      </Sheet>
    </main>
  );
}

const TERMINAL_DETAIL = new Set(["DELIVERED", "USER_CANCELLED", "QUOTE_EXPIRED", "FAILED"]);

/** Re-reads the transfer so the sheet shows the latest server status. */
function LiveTransferDetail({ initial }: { initial: ActivityItem }): React.JSX.Element {
  const session = useSession();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const resource = useApiResource(userId ? `transfer:${userId}:${initial.id}` : null, (signal) => getTransfer(initial.id, { signal }));
  const fresh = resource.status === "ready" ? toActivityItem(resource.data.transfer) : null;
  const item = fresh ?? initial;
  const [checking, setChecking] = useState(false);
  const [checkedNote, setCheckedNote] = useState<string | null>(null);
  const canCheck = !TERMINAL_DETAIL.has(item.status) && resource.status !== "loading";
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
      <TransferDetail item={item} preview={false} />
    </>
  );
}

function TransferDetail({ item, preview }: { item: ActivityItem; preview: boolean }): React.JSX.Element {
  const destination = destinationFor(item.routeId);
  const stage = STAGE_OF[item.status];
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

      {stage === "checking" && (
        <Notice tone="warn" icon="clock" title="Checking your payment — do not resend">
          We can&apos;t confirm the outcome yet. Starting another payment could pay them twice.
        </Notice>
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
      {(stage === "moving" || stage === "ready") && (
        <Notice tone="info" icon="clock" title={stage === "moving" ? "Still on its way" : "Not paid yet"}>
          {stage === "moving"
            ? "Thence is still checking this payment. A receipt appears once delivery is confirmed on their network."
            : "Nothing has been sent for this payment."}
        </Notice>
      )}

      <div className={styles.timelineCard}>
        <div className={styles.timelineHead}>
          <p className={styles.timelineTitle}>Progress</p>
          {item.statusLabel && <p className={styles.latest}>Latest: {item.statusLabel}</p>}
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
