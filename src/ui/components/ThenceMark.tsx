import { cn } from "@/ui/lib/cn";
import styles from "./shell.module.css";

/** Thence mark: a point of origin and the path away from it ("from there"). */
export function ThenceMark({ size = 32, withWordmark = true, className }: { size?: number; withWordmark?: boolean; className?: string | undefined }): React.JSX.Element {
  return (
    <span className={cn(styles.mark, className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="10" fill="var(--mint-400)" />
        <circle cx="10" cy="22" r="3" fill="var(--emerald-900)" />
        <path d="M12.5 19.5C15 13 18.5 10.5 23 10" stroke="var(--emerald-900)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path d="M18.8 8.2 23.4 10l-1.7 4.6" stroke="var(--emerald-900)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      {withWordmark ? <span className={styles.wordmark}>thence</span> : <span className="sr-only">Thence</span>}
    </span>
  );
}
