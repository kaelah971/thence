import { useId, type ReactNode } from "react";
import { cn } from "@/ui/lib/cn";
import { Icon } from "./Icon";
import { AssetMark, CardSurface, NimMark } from "./PaymentCard";
import styles from "./hero-cards.module.css";

/** Metallic floating token. Decorative only — never carries a number. */
export function Coin({ kind, className }: { kind: "nim" | "usdt"; className?: string | undefined }): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (kind === "nim") {
    const hex = "M30 4h40a6 6 0 0 1 5.2 3l20 34.6a6 6 0 0 1 0 6L75.2 82.4a6 6 0 0 1-5.2 3H30a6 6 0 0 1-5.2-3L4.8 47.6a6 6 0 0 1 0-6L24.8 7A6 6 0 0 1 30 4Z";
    return (
      <svg className={className} viewBox="0 0 100 98" aria-hidden="true">
        <defs>
          <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b97412" />
            <stop offset="1" stopColor="#7a4708" />
          </linearGradient>
          <linearGradient id={`f${id}`} x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0" stopColor="#fff1c4" />
            <stop offset="0.35" stopColor="#f6c65a" />
            <stop offset="0.7" stopColor="#e39b1f" />
            <stop offset="1" stopColor="#c27a10" />
          </linearGradient>
          <radialGradient id={`g${id}`} cx="0.32" cy="0.22" r="0.6">
            <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d={hex} fill={`url(#e${id})`} transform="translate(0 7)" />
        <path d={hex} fill={`url(#f${id})`} />
        <path d={hex} fill={`url(#g${id})`} />
        <path d={hex} fill="none" stroke="#fff6d8" strokeOpacity="0.7" strokeWidth="1.5" />
        <path d={hex} fill="none" stroke="#9a5c0b" strokeOpacity="0.45" strokeWidth="2" transform="translate(50 44.7) scale(0.62) translate(-50 -44.7)" />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#127355" />
          <stop offset="1" stopColor="#0a4733" />
        </linearGradient>
        <linearGradient id={`f${id}`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#c9f6e4" />
          <stop offset="0.4" stopColor="#4cc39b" />
          <stop offset="1" stopColor="#1a8a66" />
        </linearGradient>
        <radialGradient id={`g${id}`} cx="0.3" cy="0.22" r="0.6">
          <stop offset="0" stopColor="#fff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="56" r="44" fill={`url(#e${id})`} />
      <circle cx="50" cy="48" r="44" fill={`url(#f${id})`} />
      <circle cx="50" cy="48" r="44" fill={`url(#g${id})`} />
      <circle cx="50" cy="48" r="43" fill="none" stroke="#e6fff5" strokeOpacity="0.7" strokeWidth="1.5" />
      <circle cx="50" cy="48" r="33" fill="none" stroke="#0e5c44" strokeOpacity="0.35" strokeWidth="2" />
      <path d="M33 33h34M50 33v32M37 45c3.6 1.8 8.2 2.7 13 2.7s9.4-.9 13-2.7" stroke="#0b4a36" strokeOpacity="0.35" strokeWidth="7" fill="none" strokeLinecap="round" transform="translate(0 1.5)" />
      <path d="M33 33h34M50 33v32M37 45c3.6 1.8 8.2 2.7 13 2.7s9.4-.9 13-2.7" stroke="#f4fffb" strokeWidth="6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Blue-reference style micro-notification: a tiny bubble pointing at the card. */
export function MicroNote({ title, body, className }: { title: string; body: string; className?: string | undefined }): React.JSX.Element {
  return (
    <span className={cn(styles.note, className)} aria-hidden="true">
      <span className={styles.noteIcon}>
        <Icon name="shield" size={12} strokeWidth={2.4} />
      </span>
      <span className={styles.noteText}>
        <strong>{title}</strong>
        <span>{body}</span>
      </span>
    </span>
  );
}

interface HeroCardsProps {
  /** "hero": onboarding · "welcome": reconnect · "setup": wallet connection. */
  variant?: "hero" | "welcome" | "setup";
  label: string;
  note?: ReactNode;
  className?: string | undefined;
}

/**
 * Two wallet cards as one floating object: USDT behind, NIM in front, with
 * metallic tokens and soft stage light. Identity only — never a balance.
 */
export function HeroCards({ variant = "hero", label, note, className }: HeroCardsProps): React.JSX.Element {
  return (
    <div className={cn(styles.stage, styles[variant], className)} role="img" aria-label={label}>
      <span className={styles.halo} aria-hidden="true" />
      <span className={styles.floor} aria-hidden="true" />
      <div className={cn(styles.float, styles.backWrap)}>
        <CardSurface asset="USDT" className={styles.back}>
          <AssetMark asset="USDT" size={30} />
          <div className={styles.foot}>
            <span className={styles.small}>Tether USD</span>
            <span className={styles.name}>USDT</span>
          </div>
        </CardSurface>
      </div>
      <div className={cn(styles.float, styles.frontWrap)}>
        <CardSurface asset="NIM" className={styles.front}>
          <span className={styles.gloss} aria-hidden="true" />
          <svg className={styles.emboss} viewBox="0 0 100 88" aria-hidden="true">
            <path d="M27 2h46l25 42-25 42H27L2 44Z" />
            <path d="M38 22h24l12 22-12 22H38L26 44Z" />
          </svg>
          <NimMark size={30} />
          <div className={styles.foot}>
            <span className={styles.small}>Pay with</span>
            <span className={styles.name}>NIM</span>
          </div>
        </CardSurface>
      </div>
      <span className={cn(styles.coinWrap, styles.coinA)} aria-hidden="true">
        <Coin kind="usdt" className={styles.coin} />
      </span>
      {variant !== "setup" && (
        <span className={cn(styles.coinWrap, styles.coinB)} aria-hidden="true">
          <Coin kind="nim" className={styles.coin} />
        </span>
      )}
      {note && <span className={styles.noteSlot}>{note}</span>}
    </div>
  );
}
