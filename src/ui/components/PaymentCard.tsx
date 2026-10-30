import { useId, type ReactNode } from "react";
import type { SupportedAsset } from "@/domain/routes";
import { cn } from "@/ui/lib/cn";
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

/** USDT's sibling of the NIM orbit: concentric rings rising from the corner. */
function Rings(): React.JSX.Element {
  return (
    <svg className={styles.rings} viewBox="0 0 320 200" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">
      <circle cx="300" cy="196" r="64" />
      <circle cx="300" cy="196" r="104" />
      <circle cx="300" cy="196" r="144" />
      <circle cx="300" cy="196" r="184" />
    </svg>
  );
}

export type WalletAsset = "NIM" | "USDT";

/** Card surface shared by the wallet deck and illustrations: colour, pattern, depth. */
export function CardSurface({ asset, className, children }: { asset: WalletAsset; className?: string | undefined; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cn(styles.card, asset === "NIM" ? styles.nim : styles.usdt, className)}>
      {asset === "NIM" ? <Orbit /> : <Rings />}
      <span className={styles.sheen} aria-hidden="true" />
      {children}
    </div>
  );
}

/** Mark + name, the top-left identity on every wallet card. */
export function CardIdentity({ asset, sub }: { asset: WalletAsset; sub?: string | undefined }): React.JSX.Element {
  return (
    <span className={styles.ident}>
      {asset === "NIM" ? <NimMark size={30} /> : <AssetMark asset="USDT" size={30} />}
      <span>
        <span className={styles.identName}>{asset}</span>
        {sub && <span className={styles.identSub}>{sub}</span>}
      </span>
    </span>
  );
}
