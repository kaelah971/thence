import type { ReactNode } from "react";
import type { RouteId } from "@/domain/routes";
import type { TransferStatus } from "@/domain/transfers";
import type { AvatarTone } from "@/ui/fixtures/preview";
import { ASSET_META, destinationFor, maskAddress } from "@/ui/lib/assets";
import { formatFixed } from "@/ui/lib/calculator";
import { Avatar, Skeleton, StatusPill } from "./primitives";
import styles from "./rows.module.css";

/** View model for an activity row (mapped from GET /api/transfers, or preview fixtures). */
export interface ActivityItem {
  id: string;
  name: string;
  tone: AvatarTone;
  routeId: RouteId;
  amount: string;
  status: TransferStatus;
  /** Backend `statusLabel`, shown verbatim in details when present. */
  statusLabel?: string;
  dayLabel: string;
  timeLabel: string;
  destination?: string;
  /** R2: on-chain-verified NIM return (server-set, EXPIRED_UNFUNDED only). */
  nimReturn?: { refundTxHash: string; returnedLuna: string; feeLuna: string } | null;
}

export function formatReceive(amount: string, routeId: RouteId): string {
  const { asset } = destinationFor(routeId);
  const decimals = asset === "BTC" ? Math.max(2, (amount.split(".")[1] ?? "").length) : ASSET_META[asset].entryDecimals;
  return `${formatFixed(amount, decimals)} ${asset}`;
}

export function ActivityRow({ item, onSelect, showDay = true }: { item: ActivityItem; onSelect?: () => void; showDay?: boolean }): React.JSX.Element {
  const destination = destinationFor(item.routeId);
  const content = (
    <>
      <Avatar name={item.name} tone={item.tone} size={44} />
      <span className={styles.main}>
        <span className={styles.title}>{item.name}</span>
        <span className={styles.sub}>
          {destination.network} · {showDay ? `${item.dayLabel}, ${item.timeLabel}` : item.timeLabel}
        </span>
      </span>
      <span className={styles.end}>
        <span className={`${styles.amount} tabular`}>{formatReceive(item.amount, item.routeId)}</span>
        <StatusPill status={item.status} />
      </span>
    </>
  );
  return onSelect ? (
    <button type="button" className={styles.row} onClick={onSelect}>
      {content}
    </button>
  ) : (
    <div className={styles.row}>{content}</div>
  );
}

export interface RecipientItem {
  id: string;
  name: string;
  tone: AvatarTone;
  /** Preferred receiving currency/network; null when no receiving wallet is saved. */
  routeId: RouteId | null;
  address: string | null;
  walletVerified: boolean;
  archived?: boolean;
  transferCount?: number;
  /** Number of saved receiving wallets (more than one offers a choice when paying). */
  destinationCount?: number;
}

export function recipientSubtitle(item: Pick<RecipientItem, "routeId" | "address" | "archived">): string {
  const parts: string[] = [];
  if (item.archived) parts.push("Archived");
  if (item.routeId && item.address) parts.push(`${destinationFor(item.routeId).label} · ${maskAddress(item.address)}`);
  else parts.push("No receiving wallet yet");
  return parts.join(" · ");
}

export function RecipientRow({ item, onSelect, trailing }: { item: RecipientItem; onSelect: () => void; trailing?: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.rowWrap} data-archived={item.archived ? "true" : undefined}>
      <button type="button" className={styles.row} onClick={onSelect}>
        <Avatar name={item.name} tone={item.tone} size={44} verified={item.walletVerified} />
        <span className={styles.main}>
          <span className={styles.title}>{item.name}</span>
          <span className={styles.sub}>{recipientSubtitle(item)}</span>
        </span>
      </button>
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </div>
  );
}

export function RowSkeletons({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width={44} height={44} radius={22} />
          <span className={styles.main}>
            <Skeleton width="55%" height={12} />
            <Skeleton width="35%" height={10} />
          </span>
          <Skeleton width={64} height={20} radius={10} />
        </div>
      ))}
    </div>
  );
}
