"use client";

import { useEffect, useId, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/ui/lib/cn";
import { IconButton } from "./Button";
import styles from "./shell.module.css";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Visually hide the title (it stays the dialog's accessible name). */
  hideTitle?: boolean;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * Bottom sheet on the native <dialog> (focus trap, Escape, top layer for free).
 * While open, the presenting screen recedes like a stacked card.
 * Drag the grab bar down to dismiss.
 */
export function Sheet({ open, onClose, title, hideTitle = false, children, className }: SheetProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startT: number; dy: number } | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const root = document.documentElement;
    if (open && !dialog.open) {
      dialog.showModal();
      root.dataset.sheet = "open";
    } else if (!open && dialog.open) {
      dialog.close();
    }
    if (!open) delete root.dataset.sheet;
    return () => {
      delete root.dataset.sheet;
    };
  }, [open]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startT: event.timeStamp, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || !panel) return;
    state.dy = Math.max(0, event.clientY - state.startY);
    panel.style.transition = "none";
    panel.style.transform = `translate3d(0, ${state.dy}px, 0)`;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!state || !panel) return;
    const velocity = state.dy / Math.max(1, event.timeStamp - state.startT);
    panel.style.transition = "";
    panel.style.transform = "";
    if (state.dy > 110 || velocity > 0.6) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} className={cn(styles.sheetPanel, "th-light", className)}>
        <div
          className={styles.grabZone}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-hidden="true"
        >
          <span className={styles.grabBar} />
        </div>
        <div className={styles.sheetHeader}>
          <h2 id={titleId} className={cn(styles.sheetTitle, hideTitle && "sr-only")}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" tone="light" onClick={onClose} className={styles.sheetClose} />
        </div>
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </dialog>
  );
}
