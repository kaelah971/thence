import { useId, type ReactNode } from "react";
import type { SupportedAsset } from "@/domain/routes";
import { cn } from "@/ui/lib/cn";
import { destinationFor, type Destination } from "@/ui/lib/assets";
import type { RouteId } from "@/domain/routes";
import styles from "./cards.module.css";

export function NimMark({ size = 28 }: { size?: number }): React.JSX.Element {
  const gradientId = `nim-g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f8cf6a" />
          <stop offset="1" stopColor="#e39b1f" />
        </linearGradient>
      </defs>
      <path d="M10.2 3.5h11.6a3 3 0 0 1 2.6 1.5l5.8 10a3 3 0 0 1 0 3l-5.8 10a3 3 0 0 1-2.6 1.5H10.2a3 3 0 0 1-2.6-1.5l-5.8-10a3 3 0 0 1 0-3l5.8-10a3 3 0 0 1 2.6-1.5Z" fill={`url(#${gradientId})`} transform="translate(0 -1.5)" />
    </svg>
  );
}

export function AssetMark({ asset, size = 28 }: { asset: SupportedAsset; size?: number }): React.JSX.Element {
  const fill = asset === "USDC" ? "var(--usdc-blue)" : asset === "USDT" ? "var(--usdt-teal)" : "var(--btc-orange)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill={fill} />
      {asset === "USDC" && (
        <>
          <path d="M12.2 7.6a9.4 9.4 0 0 0 0 16.8M19.8 7.6a9.4 9.4 0 0 1 0 16.8" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M18.6 13.4c-.3-1.2-1.4-1.9-2.7-1.9-1.6 0-2.7.8-2.7 2 0 2.8 5.6 1.4 5.6 4.4 0 1.2-1.2 2.1-2.9 2.1-1.5 0-2.6-.7-2.9-1.9M16 10v1.5M16 20v1.6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </>
      )}
      {asset === "USDT" && <path d="M10 10.5h12M16 10.5v11M11.5 15c1.2.6 2.8.9 4.5.9s3.3-.3 4.5-.9" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />}
      {asset === "BTC" && <path d="M17.5 7 11 17.5h5L14.5 25l6.5-10.5h-5z" fill="#fff" />}
    </svg>
  );
}

function Orbit(): React.JSX.Element {
  return (
    <svg className={styles.orbit} viewBox="0 0 320 200" preserveAspectRatio="none" aria-hidden="true">
      <ellipse cx="250" cy="170" rx="190" ry="88" transform="rotate(-18 250 170)" />
      <ellipse cx="270" cy="190" rx="130" ry="60" transform="rotate(-18 270 190)" />
    </svg>
  );
}

interface NimCardProps {
  footer?: ReactNode;
  eyebrow?: string;
  className?: string | undefined;
}

/** The sender's NIM card. Shows identity only — never a fabricated balance or number. */
export function NimCard({ footer, eyebrow = "Pay with", className }: NimCardProps): React.JSX.Element {
  return (
    <div className={cn(styles.card, styles.nim, className)}>
      <Orbit />
      <span className={styles.sheen} aria-hidden="true" />
      <div className={styles.cardTop}>
        <NimMark />
        <span className={styles.cardEyebrow}>{eyebrow}</span>
      </div>
      <div className={styles.cardBottom}>
        <div>
          <p className={styles.cardAsset}>NIM</p>
          <p className={styles.cardSub}>Nimiq</p>
        </div>
        {footer && <div className={styles.cardFooter}>{footer}</div>}
      </div>
    </div>
  );
}

interface DestinationCardProps {
  destination: Destination;
  eyebrow?: string;
  className?: string | undefined;
}

export function DestinationCard({ destination, eyebrow = "They receive", className }: DestinationCardProps): React.JSX.Element {
  return (
    <div className={cn(styles.card, styles.dest, styles[`dest-${destination.asset}`], className)}>
      <span className={styles.sheen} aria-hidden="true" />
      <div className={styles.cardTop}>
        <span className={styles.destIdentity}>
          <AssetMark asset={destination.asset} />
          <span>
            <span className={styles.destAsset}>{destination.asset}</span>
            <span className={styles.destNetwork}>{destination.network}</span>
          </span>
        </span>
        <span className={styles.cardEyebrow}>{eyebrow}</span>
      </div>
    </div>
  );
}

interface CardStackProps {
  routeId: RouteId;
  size?: "hero" | "home" | "compact";
  nimFooter?: ReactNode;
  label: string;
  className?: string | undefined;
}

/**
 * Signature layered stack: NIM in front, the destination card emerging
 * behind it. Re-keying on route makes the back card glide out again.
 */
export function CardStack({ routeId, size = "home", nimFooter, label, className }: CardStackProps): React.JSX.Element {
  const destination = destinationFor(routeId);
  return (
    <div className={cn(styles.stack, styles[`stack-${size}`], className)} role="img" aria-label={label}>
      <div className={styles.stackBack} key={routeId}>
        <DestinationCard destination={destination} />
      </div>
      <div className={styles.stackFront}>
        <NimCard footer={nimFooter} />
      </div>
    </div>
  );
}
