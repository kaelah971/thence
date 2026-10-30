"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import styles from "./swipe.module.css";

interface SwipeToConfirmProps {
  label: string;
  completedLabel: string;
  onComplete: () => void;
  handle?: ReactNode;
  disabled?: boolean;
}

const THRESHOLD = 0.86;

/**
 * Drag-right confirmation pill. Keyboard users press Enter/Space on the
 * handle; a separate tap alternative is provided by the screen.
 * Completing only reports intent to the caller — it never moves money.
 */
export function SwipeToConfirm({ label, completedLabel, onComplete, handle, disabled = false }: SwipeToConfirmProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ startX: number; x: number; max: number; moved: boolean } | null>(null);
  const [done, setDone] = useState(false);
  const [nudge, setNudge] = useState(false);
  const moved = useRef(false);

  const paint = (x: number, max: number, animate: boolean) => {
    const progress = max > 0 ? x / max : 0;
    for (const el of [handleRef.current, fillRef.current, labelRef.current]) {
      if (el) el.style.transition = animate ? "" : "none";
    }
    if (handleRef.current) handleRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    if (fillRef.current) fillRef.current.style.transform = `translate3d(${x - max}px, 0, 0)`;
    if (labelRef.current) labelRef.current.style.opacity = String(Math.max(0, 1 - progress * 1.6));
  };

  const measure = () => {
    const track = trackRef.current;
    const knob = handleRef.current;
    if (!track || !knob) return 0;
    const pad = 6;
    return track.clientWidth - knob.offsetWidth - pad * 2;
  };

  const complete = () => {
    if (done || disabled) return;
    paint(measure(), measure(), true);
    setDone(true);
    onComplete();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (done || disabled) return;
    drag.current = { startX: event.clientX, x: 0, max: measure(), moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    state.x = Math.min(state.max, Math.max(0, event.clientX - state.startX));
    if (state.x > 4) state.moved = true;
    paint(state.x, state.max, false);
  };

  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    moved.current = state.moved;
    if (state.x >= state.max * THRESHOLD) complete();
    else paint(0, state.max, true);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) complete();
    else if (!done && !moved.current) setNudge(true);
    moved.current = false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      complete();
    }
  };

  return (
    <div ref={trackRef} className={styles.track} data-done={done} data-disabled={disabled}>
      <span ref={fillRef} className={styles.fill} aria-hidden="true" />
      <span ref={labelRef} className={styles.label} aria-hidden="true">
        <span className={styles.labelText}>{done ? completedLabel : label}</span>
        {!done && (
          <span className={styles.chevrons}>
            <Icon name="chevron-right" size={16} strokeWidth={2.4} />
            <Icon name="chevron-right" size={16} strokeWidth={2.4} />
          </span>
        )}
      </span>
      <button
        ref={handleRef}
        type="button"
        className={styles.handle}
        data-nudge={nudge}
        onAnimationEnd={() => setNudge(false)}
        aria-label={done ? completedLabel : `${label}. Swipe right, or press Enter.`}
        aria-disabled={disabled || done}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {done ? <Icon name="check" size={22} strokeWidth={2.6} /> : (handle ?? <Icon name="arrow-right" size={22} strokeWidth={2.4} />)}
      </button>
    </div>
  );
}
