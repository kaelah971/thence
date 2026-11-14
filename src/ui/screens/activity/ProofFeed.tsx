"use client";

import { useEffect, useRef, useState } from "react";
import { AddressDisplay } from "@/ui/components/AddressDisplay";
import { Button } from "@/ui/components/Button";
import { Icon } from "@/ui/components/Icon";
import { AssetMark, NimMark } from "@/ui/components/PaymentCard";
import { Notice, PreviewTag, Skeleton } from "@/ui/components/primitives";
import { Sheet } from "@/ui/components/Sheet";
import { PREVIEW_PROOFS } from "@/ui/fixtures/preview";
import {
  classifyProofFailure,
  displayableProofs,
  explorerHost,
  getProof,
  isDisplayableProof,
  listProofs,
  shortHash,
  toProofDisplay,
  type ProofFeedPage,
  type ProofView,
} from "@/ui/lib/proofs-api";
import { usePreviewMode } from "@/ui/lib/stores";
import styles from "./proof-feed.module.css";

/* ---------------- data ---------------- */

type FeedState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; proofs: ProofView[]; nextCursor: string | null; hasMore: boolean; preview: boolean };

/**
 * Global proof feed (A3c.1 API). Preview mode shows labelled fixtures and
 * never calls the API; otherwise only server-published, fully verified rows.
 */
const PREVIEW_FEED: FeedState = {
  status: "ready",
  // Labelled preview fixtures (see fixtures/preview.ts): same shape, never real.
  proofs: PREVIEW_PROOFS as unknown as ProofView[],
  nextCursor: null,
  hasMore: false,
  preview: true,
};

function readyFrom(page: ProofFeedPage | null | undefined, seen?: ReadonlySet<string>): { proofs: ProofView[]; nextCursor: string | null; hasMore: boolean } {
  const nextCursor = typeof page?.pagination?.nextCursor === "string" ? page.pagination.nextCursor : null;
  return { proofs: displayableProofs(page?.proofs, seen), nextCursor, hasMore: page?.pagination?.hasMore === true && nextCursor !== null };
}

function useProofFeed(preview: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ attempt: number; state: FeedState } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void listProofs({}, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        if (result.kind === "aborted") return;
        const failure = classifyProofFailure(result);
        setSettled({
          attempt,
          state: failure.state === "unavailable" ? { status: "unavailable" } : { status: "error", message: failure.state === "error" ? failure.message : "The proof feed couldn't be found. Try again." },
        });
        return;
      }
      setSettled({ attempt, state: { status: "ready", ...readyFrom(result.data), preview: false } });
    });
    return () => controller.abort();
  }, [preview, attempt]);

  useEffect(() => () => moreController.current?.abort(), []);

  const state: FeedState = preview ? PREVIEW_FEED : settled && settled.attempt === attempt ? settled.state : { status: "loading" };

  const loadMore = () => {
    if (state.status !== "ready" || state.preview || !state.hasMore || !state.nextCursor || loadingMore) return;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    const cursor = state.nextCursor;
    void listProofs({ cursor }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          const failure = classifyProofFailure(result);
          if (failure.state === "unavailable") setSettled({ attempt, state: { status: "unavailable" } });
          else setMoreError(failure.state === "error" ? failure.message : "Couldn't load older proofs. Try again.");
          return;
        }
        setSettled((prev) => {
          if (!prev || prev.state.status !== "ready") return prev;
          const current = prev.state;
          const next = readyFrom(result.data, new Set(current.proofs.map((p) => p.proofId)));
          return { attempt: prev.attempt, state: { ...current, proofs: [...current.proofs, ...next.proofs], nextCursor: next.nextCursor, hasMore: next.hasMore } };
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  };

  return { state, retry: () => setAttempt((n) => n + 1), loadMore, loadingMore, moreError };
}

/* ---------------- feed ---------------- */

export function ProofFeed({ onShowMine }: { onShowMine: () => void }): React.JSX.Element {
  const preview = usePreviewMode();
  const feed = useProofFeed(preview);
  const [selected, setSelected] = useState<ProofView | null>(null);
  const { state } = feed;

  return (
    <div className={styles.feed}>
      <header className={styles.head}>
        <span className={styles.headIcon} aria-hidden="true">
          <Icon name="globe" size={22} />
        </span>
        <div className={styles.headText}>
          <h2 className={styles.title}>Global proof of payments</h2>
          <p className={styles.subtitle}>Public record of delivered payments on Thence.</p>
        </div>
      </header>

      {state.status === "ready" && state.preview && (
        <div className={styles.previewRow}>
          <PreviewTag>Preview proofs · fictional, nothing was sent</PreviewTag>
        </div>
      )}

      {(state.status === "ready" || state.status === "loading") && (
        <p className={styles.rule}>
          <Icon name="shield" size={16} />
          <span>Only payments verified on both networks appear here — the NIM sent on Nimiq and the USDC received on-chain.</span>
        </p>
      )}

      {state.status === "loading" && <ProofSkeletons />}

      {state.status === "unavailable" && (
        <div className={styles.state}>
          <span className={styles.stateArt} aria-hidden="true">
            <Icon name="shield" size={26} />
          </span>
          <p className={styles.stateTitle}>Proof feed isn&apos;t published yet</p>
          <p className={styles.stateBody}>
            Delivered payments will appear here once Thence starts publishing public proofs. Each one shows the exact NIM sent and
            USDC received, and how each was checked. The NIM payment is read from a named Nimiq RPC (NimiqWatch for recovered
            payments), and Thence relies on that RPC for Nimiq finality. The USDC delivery is read from Polygon; for recovered
            payments, two separate RPC providers must agree.
          </p>
          <div className={styles.stateAction}>
            <Button variant="soft" size="md" icon="user" onClick={onShowMine}>
              See my activity
            </Button>
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className={styles.state}>
          <span className={styles.stateArt} aria-hidden="true">
            <Icon name="alert" size={26} />
          </span>
          <p className={styles.stateTitle}>Couldn&apos;t load the proof feed</p>
          <p className={styles.stateBody}>{state.message}</p>
          <div className={styles.stateAction}>
            <Button variant="soft" size="md" icon="refresh" onClick={feed.retry}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {state.status === "ready" && state.proofs.length === 0 && (
        <div className={styles.state}>
          <span className={styles.stateArt} aria-hidden="true">
            <Icon name="globe" size={26} />
          </span>
          <p className={styles.stateTitle}>No published proofs yet</p>
          <p className={styles.stateBody}>Delivered payments appear here once both the NIM payment and the USDC delivery are verified.</p>
        </div>
      )}

      {state.status === "ready" && state.proofs.length > 0 && (
        <ul className={styles.list} aria-label="Delivered payments">
          {state.proofs.map((proof) => (
            <li key={proof.proofId}>
              <ProofCard proof={proof} onOpen={() => setSelected(proof)} />
            </li>
          ))}
        </ul>
      )}

      {state.status === "ready" && state.hasMore && (
        <div className={styles.more}>
          <Button variant="soft" size="md" onClick={feed.loadMore} disabled={feed.loadingMore} aria-busy={feed.loadingMore}>
            {feed.loadingMore ? "Loading…" : "Show older proofs"}
          </Button>
          {feed.moreError && <p className={styles.moreError}>{feed.moreError}</p>}
        </div>
      )}

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title="Payment proof">
        {selected && (state.status === "ready" && state.preview ? (
          <ProofDetail proof={selected} preview />
        ) : (
          <LiveProofDetail key={selected.proofId} initial={selected} />
        ))}
      </Sheet>
    </div>
  );
}

function ProofSkeletons(): React.JSX.Element {
  return (
    <div className={styles.list} aria-busy="true" aria-label="Loading proofs">
      {[0, 1, 2].map((i) => (
        <div key={i} className={styles.skeletonCard}>
          <Skeleton width={44} height={44} radius={22} />
          <div className={styles.skeletonLines}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="35%" height={12} />
            <Skeleton width="80%" height={12} />
          </div>
          <Skeleton width={64} height={36} />
        </div>
      ))}
    </div>
  );
}

function PairMark(): React.JSX.Element {
  return (
    <span className={styles.pair} aria-hidden="true">
      <NimMark size={28} />
      <span className={styles.pairUsdc}>
        <AssetMark asset="USDC" size={20} />
      </span>
    </span>
  );
}

function ProofCard({ proof, onOpen }: { proof: ProofView; onOpen: () => void }): React.JSX.Element {
  const d = toProofDisplay(proof);
  return (
    <button
      type="button"
      className={styles.card}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${d.nimSent} NIM sent, ${d.usdcReceived} USDC received on ${d.network}, ${d.dateTimeLabel}. ${d.outcome === "SHORT" ? `Delivered, ${d.usdcShortfall} USDC less than requested` : "Delivered"} and verified. Open proof.`}
    >
      <PairMark />
      <span className={styles.main}>
        <span className={styles.when}>{d.dateTimeLabel}</span>
        <span className={styles.network}>
          <span className={styles.networkDot} data-network={d.network} aria-hidden="true" />
          {d.network}
        </span>
        <span className={styles.parties}>
          <span className={styles.party}>
            <Icon name="arrow-up-right" size={14} strokeWidth={2.2} />
            <span className={styles.partyLabel}>
              <span className={styles.labelLong}>Sender (NIM)</span>
              <span className={styles.labelShort} aria-hidden="true">From</span>
            </span>
            <span className={styles.partyValue}>{d.senderShort}</span>
          </span>
          <span className={styles.party}>
            <Icon name="arrow-down-left" size={14} strokeWidth={2.2} />
            <span className={styles.partyLabel}>
              <span className={styles.labelLong}>Recipient (USDC)</span>
              <span className={styles.labelShort} aria-hidden="true">To</span>
            </span>
            <span className={styles.partyValue}>{d.recipientShort}</span>
          </span>
        </span>
      </span>
      <span className={styles.amounts}>
        <span className={styles.amountNim}>
          {d.nimSent} <span className={styles.unit}>NIM</span>
        </span>
        <span className={styles.amountUsdc}>
          {d.usdcReceived} <span className={styles.unit}>USDC</span>
        </span>
        <span className={styles.delivered} data-outcome={d.outcome}>
          <span className={styles.deliveredDot} />
          {d.outcomeLabel}
        </span>
      </span>
    </button>
  );
}

/* ---------------- detail ---------------- */

/** Re-reads the proof from GET /api/proofs/:id so the sheet shows the server's current publication. */
function LiveProofDetail({ initial }: { initial: ProofView }): React.JSX.Element {
  const [proof, setProof] = useState<ProofView>(initial);
  const [notice, setNotice] = useState<"withdrawn" | "stale" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getProof(initial.proofId, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        if (isDisplayableProof(result.data?.proof)) setProof(result.data.proof);
        else setNotice("withdrawn");
        return;
      }
      if (result.kind === "aborted") return;
      const failure = classifyProofFailure(result);
      setNotice(failure.state === "error" ? "stale" : "withdrawn");
    });
    return () => controller.abort();
  }, [initial.proofId]);

  if (notice === "withdrawn") {
    return (
      <Notice tone="warn" icon="alert" title="This proof is no longer published">
        Thence isn&apos;t publishing this payment right now, so its proof isn&apos;t shown.
      </Notice>
    );
  }
  return (
    <>
      {notice === "stale" && (
        <Notice tone="warn" icon="info" title="Showing the proof as last loaded">
          Couldn&apos;t refresh this proof just now. Every value below was verified when the feed loaded.
        </Notice>
      )}
      <ProofDetail proof={proof} preview={false} />
    </>
  );
}

function ProofDetail({ proof, preview }: { proof: ProofView; preview: boolean }): React.JSX.Element {
  const d = toProofDisplay(proof);
  return (
    <div className={styles.detail}>
      <div className={styles.hero}>
        <PairMark />
        <p className={styles.heroLabel}>They received</p>
        <p className={styles.heroAmount}>
          {d.usdcReceived} <span className={styles.heroUnit}>USDC</span>
        </p>
        <p className={styles.heroFrom}>
          for <strong className="tabular">{d.nimSent} NIM</strong> · on {d.network}
        </p>
        <div className={styles.heroBadges}>
          <span className={styles.delivered} data-outcome={d.outcome}>
            <span className={styles.deliveredDot} />
            {d.outcomeLabel}
          </span>
          <span className={styles.verified}>
            <Icon name="shield" size={13} strokeWidth={2.2} />
            Verified on both networks
          </span>
          {preview && <PreviewTag />}
        </div>
        <p className={styles.heroWhen}>{d.dateTimeLabel}</p>
      </div>

      <Leg
        icon="arrow-up-right"
        title={`Sent on ${d.sourceNetworkLabel}`}
        rows={[
          { label: "Sender", value: <AddressDisplay address={d.sender} />, block: true },
          { label: "NIM sent", value: <span className="tabular">{d.nimSent} NIM</span> },
          { label: "Network fee", value: <span className="tabular">{d.nimFee} NIM</span> },
          { label: "Total debited", value: <span className="tabular">{d.nimTotal} NIM</span> },
          ...(d.sourceConfirmations !== null && !preview ? [{ label: "Confirmations", value: <span className="tabular">{d.sourceConfirmations}</span> }] : []),
        ]}
        hash={d.sourceTxHash}
        explorerUrl={preview ? null : d.sourceExplorerUrl}
        preview={preview}
      />

      <Leg
        icon="arrow-down-left"
        title={`Delivered on ${d.network}`}
        rows={[
          { label: "Recipient", value: <AddressDisplay address={d.recipient} />, block: true },
          // R7: a short delivery always discloses requested, received and shortfall.
          ...(d.outcome === "SHORT" && d.usdcRequested ? [{ label: "Requested", value: <span className="tabular">{d.usdcRequested} USDC</span> }] : []),
          { label: "USDC received", value: <span className="tabular">{d.usdcReceived} USDC</span> },
          ...(d.outcome === "SHORT" && d.usdcShortfall ? [{ label: "Shortfall", value: <span className="tabular">{d.usdcShortfall} USDC</span> }] : []),
          ...(d.outcome === "FULL" && d.usdcRequested && d.usdcRequested !== d.usdcReceived ? [{ label: "Requested", value: <span className="tabular">{d.usdcRequested} USDC</span> }] : []),
          ...(d.finalityLabel && !preview ? [{ label: "Finality", value: d.finalityLabel }] : []),
        ]}
        hash={d.destinationTxHash}
        explorerUrl={preview ? null : d.destinationExplorerUrl}
        preview={preview}
      />

      {d.method && !preview && (
        <section className={styles.leg} aria-label="How this was verified">
          <p className={styles.legTitle}>
            <span className={styles.legIcon} aria-hidden="true">
              <Icon name="shield" size={14} strokeWidth={2.4} />
            </span>
            How this was verified
          </p>
          <dl className={styles.rows}>
            <div data-block="true">
              <dt>Method</dt>
              <dd>{d.method.kindLabel}</dd>
            </div>
            <div data-block="true">
              <dt>NIM checked via</dt>
              <dd>{d.method.sourceChecked}</dd>
            </div>
            <div data-block="true">
              <dt>NIM finality</dt>
              <dd>{d.method.sourceFinality}</dd>
            </div>
            <div data-block="true">
              <dt>USDC checked via</dt>
              <dd>{d.method.destinationChecked}</dd>
            </div>
            <div data-block="true">
              <dt>USDC finality</dt>
              <dd>{d.method.destinationFinality}</dd>
            </div>
          </dl>
        </section>
      )}

      <p className={styles.footnote}>
        <Icon name="info" size={14} />
        <span>
          {preview
            ? "Preview fixture. Real proofs link to both blockchain explorers."
            : "Amounts are exact on-chain values, not estimates. Payment hashes and HTLC internals are never published."}
        </span>
      </p>
    </div>
  );
}

interface LegRow {
  label: string;
  value: React.ReactNode;
  block?: boolean;
}

function Leg({
  icon,
  title,
  rows,
  hash,
  explorerUrl,
  preview,
}: {
  icon: "arrow-up-right" | "arrow-down-left";
  title: string;
  rows: LegRow[];
  hash: string;
  explorerUrl: string | null;
  preview: boolean;
}): React.JSX.Element {
  const host = explorerHost(explorerUrl);
  return (
    <section className={styles.leg} aria-label={title}>
      <p className={styles.legTitle}>
        <span className={styles.legIcon} aria-hidden="true">
          <Icon name={icon} size={14} strokeWidth={2.4} />
        </span>
        {title}
      </p>
      <dl className={styles.rows}>
        {rows.map((row) => (
          <div key={row.label} data-block={row.block ? "true" : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
        <div data-block="true">
          <dt>Transaction</dt>
          <dd>
            <span className={styles.hash} title={hash}>
              {hash}
            </span>
          </dd>
        </div>
      </dl>
      {explorerUrl && host ? (
        <a className={styles.explorer} href={explorerUrl} target="_blank" rel="noopener noreferrer">
          View on {host}
          <Icon name="external" size={15} strokeWidth={2.2} />
          <span className="sr-only"> (opens in a new tab, transaction {shortHash(hash)})</span>
        </a>
      ) : (
        <p className={styles.explorerMuted}>{preview ? "Explorer link shown for real proofs" : "Explorer link unavailable"}</p>
      )}
    </section>
  );
}
