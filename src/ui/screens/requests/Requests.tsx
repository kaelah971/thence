"use client";

import { useState } from "react";
import { routeIdForPair } from "@/domain/routes";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark } from "@/ui/components/PaymentCard";
import { EmptyState, FilterChips, Notice } from "@/ui/components/primitives";
import { RowSkeletons } from "@/ui/components/rows";
import { ShareLink } from "@/ui/components/ShareLink";
import { Sheet } from "@/ui/components/Sheet";
import shell from "@/ui/components/shell.module.css";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { destinationFor } from "@/ui/lib/assets";
import { friendlyMessage } from "@/ui/lib/api";
import { formatFixed } from "@/ui/lib/calculator";
import { cn } from "@/ui/lib/cn";
import { invalidateData, useApiResource } from "@/ui/lib/resource";
import { cancelPaymentRequest, formatRequestDate, listPaymentRequests, requestStatusLabel, type ApiOwnerRequest, type RequestStatus } from "@/ui/lib/requests-api";
import { useSession } from "@/ui/lib/session";
import { usePreviewMode } from "@/ui/lib/stores";
import styles from "./requests.module.css";

type Filter = "all" | RequestStatus;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

export function formatRequestAmount(request: Pick<ApiOwnerRequest, "amount" | "asset">): string {
  return `${formatFixed(request.amount, Math.max(2, (request.amount.split(".")[1] ?? "").length))} ${request.asset}`;
}

function assetOf(request: ApiOwnerRequest) {
  const routeId = routeIdForPair(request.asset, request.network);
  return routeId ? destinationFor(routeId).asset : null;
}

export function Requests(): React.JSX.Element {
  const session = useSession();
  const preview = usePreviewMode();
  const userId = session.status === "valid" ? session.me.user.id : null;
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resource = useApiResource(userId && !preview ? `requests:${userId}:${filter}` : null, (signal) => listPaymentRequests({ status: filter }, { signal }));
  const items = resource.status === "ready" ? resource.data.requests : [];
  const selected = items.find((r) => r.publicId === selectedId) ?? null;

  return (
    <main className={shell.screen}>
      <section className={shell.darkTop}>
        <span className={shell.glow} aria-hidden="true" />
        <h1 className={shell.title}>Requests</h1>
        <p className={styles.lede}>Links you&apos;ve shared to get paid.</p>
        <div className={styles.topAction}>
          <ButtonLink href="/app/send?mode=request" variant="light" size="md" icon="arrow-down-left">
            New request
          </ButtonLink>
        </div>
      </section>

      <section className={`${shell.paper} th-light`}>
        <span className={shell.paperHandle} aria-hidden="true" />
        {preview ? (
          <EmptyState icon="eye" title="Requests aren't shown in preview" body="Connect your wallet to create and manage payment requests." />
        ) : (
          <>
            <FilterChips label="Filter requests" options={FILTERS} value={filter} onChange={setFilter} />
            {(resource.status === "loading" || resource.status === "idle") && <RowSkeletons count={3} />}
            {resource.status === "error" && (
              <EmptyState
                icon="alert"
                title="Couldn't load your requests"
                body={resource.message}
                action={
                  <Button variant="soft" size="md" icon="refresh" onClick={resource.retry}>
                    Try again
                  </Button>
                }
              />
            )}
            {resource.status === "ready" && items.length === 0 && (
              <EmptyState
                icon="link"
                title={filter === "all" ? "No requests yet" : "Nothing here"}
                body={filter === "all" ? "Ask someone to pay you with a link. They'll see exactly what to send." : "No requests match this filter."}
                action={
                  filter === "all" ? (
                    <ButtonLink href="/app/send?mode=request" variant="ink" size="md" icon="arrow-down-left">
                      Request money
                    </ButtonLink>
                  ) : (
                    <Button variant="soft" size="md" onClick={() => setFilter("all")}>
                      Show all requests
                    </Button>
                  )
                }
              />
            )}
            {items.length > 0 && (
              <ul className={styles.list} aria-busy={resource.status === "ready" && resource.refreshing}>
                {items.map((r) => {
                  const asset = assetOf(r);
                  return (
                    <li key={r.publicId}>
                      <button type="button" className={styles.row} onClick={() => setSelectedId(r.publicId)}>
                        <span className={styles.mark}>{asset ? <AssetMark asset={asset} size={40} /> : <Icon name="link" size={20} />}</span>
                        <span className={styles.main}>
                          <span className={cn(styles.amount, "tabular")}>{formatRequestAmount(r)}</span>
                          <span className={styles.sub}>
                            {r.network}
                            {r.memo ? ` · ${r.memo}` : ""}
                          </span>
                        </span>
                        <RequestPill status={r.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <Sheet open={selected !== null} onClose={() => setSelectedId(null)} title="Payment request">
        {selected && <RequestDetail key={selected.publicId} request={selected} />}
      </Sheet>
    </main>
  );
}

export function RequestPill({ status }: { status: RequestStatus }): React.JSX.Element {
  return (
    <span className={styles.pill} data-status={status}>
      <span className={styles.pillDot} aria-hidden="true" />
      {requestStatusLabel(status)}
    </span>
  );
}

function RequestDetail({ request }: { request: ApiOwnerRequest }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expires = formatRequestDate(request.expiresAt);
  const created = formatRequestDate(request.createdAt);
  const cancelled = formatRequestDate(request.cancelledAt);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    const result = await cancelPaymentRequest(request.publicId);
    setBusy(false);
    if (result.ok) {
      setConfirming(false);
      invalidateData();
    } else if (result.kind !== "aborted") {
      setError(friendlyMessage(result));
    }
  };

  return (
    <div className={styles.detail}>
      <div className={styles.detailHero}>
        <p className={styles.detailWho}>{request.recipientName} requested</p>
        <p className={cn(styles.detailAmount, "tabular")}>{formatRequestAmount(request)}</p>
        <p className={styles.detailNet}>on {request.network}</p>
        <RequestPill status={request.status} />
      </div>

      {request.status === "active" ? (
        <ShareLink url={request.url} title={`Payment request from ${request.recipientName}`} />
      ) : (
        <Notice tone="info" icon="lock" title={request.status === "expired" ? "This request has expired" : "This request was cancelled"}>
          The link no longer accepts payments. Create a new request if you still need to be paid.
        </Notice>
      )}

      <dl className={styles.facts}>
        <div>
          <dt>Your wallet</dt>
          <dd>
            <AddressDisplay address={request.destination} align="end" />
          </dd>
        </div>
        {request.memo && (
          <div>
            <dt>Note</dt>
            <dd>{request.memo}</dd>
          </div>
        )}
        {created && (
          <div>
            <dt>Created</dt>
            <dd>{created}</dd>
          </div>
        )}
        {request.status === "cancelled" && cancelled ? (
          <div>
            <dt>Cancelled</dt>
            <dd>{cancelled}</dd>
          </div>
        ) : (
          expires && (
            <div>
              <dt>{request.status === "expired" ? "Expired" : "Expires"}</dt>
              <dd>{expires}</dd>
            </div>
          )
        )}
      </dl>

      {error && (
        <Notice tone="error" icon="alert" live>
          {error}
        </Notice>
      )}

      {request.status === "active" &&
        (confirming ? (
          <div className={styles.confirm}>
            <p className={styles.confirmText}>Cancel this request? The link stops working for everyone. This can&apos;t be undone.</p>
            <div className={styles.confirmActions}>
              <Button variant="soft" size="md" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="ink" size="md" onClick={() => void cancel()} disabled={busy} aria-busy={busy}>
                {busy ? "Cancelling…" : "Cancel request"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="soft" block icon="close" onClick={() => setConfirming(true)}>
            Cancel request
          </Button>
        ))}
    </div>
  );
}
