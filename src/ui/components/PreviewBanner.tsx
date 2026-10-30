"use client";

import { setPreviewMode, usePreviewMode } from "@/ui/lib/stores";
import { Icon } from "./Icon";
import styles from "./shell.module.css";

/** Persistent, unmissable label whenever preview fixtures are on screen. */
export function PreviewBanner(): React.JSX.Element | null {
  const preview = usePreviewMode();
  if (!preview) return null;
  return (
    <div className={styles.previewBanner} role="status">
      <Icon name="eye" size={15} strokeWidth={2.2} />
      <span>
        <strong>Preview data</strong> · fictional, not real payments
      </span>
      <button type="button" className={styles.previewExit} onClick={() => setPreviewMode(false)}>
        Exit
      </button>
    </div>
  );
}
