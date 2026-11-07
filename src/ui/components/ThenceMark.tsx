import Image from "next/image";
import { cn } from "@/ui/lib/cn";
import styles from "./shell.module.css";

/**
 * Thence mark: the official brand logo (public/brand/thence-mark.png, a
 * resize of the supplied artwork — never redrawn), plus the wordmark.
 */
export function ThenceMark({ size = 32, withWordmark = true, className }: { size?: number; withWordmark?: boolean; className?: string | undefined }): React.JSX.Element {
  return (
    <span className={cn(styles.mark, className)}>
      <Image
        src="/brand/thence-mark.png"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        unoptimized
        priority
        style={{ borderRadius: Math.round(size * 0.3), display: "block" }}
      />
      {withWordmark ? <span className={styles.wordmark}>thence</span> : <span className="sr-only">Thence</span>}
    </span>
  );
}
