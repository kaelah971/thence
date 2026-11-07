"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, IconButton } from "@/ui/components/Button";
import { ThenceMark } from "@/ui/components/ThenceMark";
import { markIntroSeen } from "@/ui/lib/stores";
import { MoneyArt, PeopleArt, TrustArt } from "./illustrations";
import styles from "./onboarding.module.css";

const SLIDES = [
  {
    id: "money",
    title: "Your NIM can go further.",
    body: "Use NIM, Nimiq's cryptocurrency, to pay someone in digital dollars. Starting with USDC on Polygon.",
    note: null,
    Art: MoneyArt,
  },
  {
    id: "people",
    title: "They don't need NIM to get paid.",
    body: "Add their receiving wallet, choose how much they'll get, and see exactly what you'll pay before approving.",
    note: "Your NIM → Their USDC",
    Art: PeopleArt,
  },
  {
    id: "trust",
    title: "Know when it arrives.",
    body: "Follow your payment every step of the way. See a receipt once it's delivered.",
    note: null,
    Art: TrustArt,
  },
] as const;

const LAST = SLIDES.length - 1;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startT: number;
  dx: number;
  axis: "x" | "y" | null;
  width: number;
}

export function Onboarding(): React.JSX.Element {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const artTrack = useRef<HTMLDivElement>(null);
  const copyTrack = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);

  const paint = useCallback((i: number, dx: number, animate: boolean) => {
    for (const track of [artTrack.current, copyTrack.current]) {
      if (!track) continue;
      track.style.transition = animate ? "" : "none";
      track.style.transform = `translate3d(calc(${-i * 100}% + ${dx}px), 0, 0)`;
    }
  }, []);

  useEffect(() => {
    paint(index, 0, true);
  }, [index, paint]);

  const go = useCallback((next: number) => setIndex(Math.min(LAST, Math.max(0, next))), []);

  const finish = () => {
    markIntroSeen();
    router.push("/app/setup/name");
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startT: event.timeStamp,
      dx: 0,
      axis: null,
      width: event.currentTarget.clientWidth,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (state.axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (state.axis === "x") event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (state.axis !== "x") return;
    const atEdge = (index === 0 && dx > 0) || (index === LAST && dx < 0);
    state.dx = atEdge ? dx * 0.3 : dx;
    paint(index, state.dx, false);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.axis !== "x") return;
    const velocity = state.dx / Math.max(1, event.timeStamp - state.startT);
    const passed = Math.abs(state.dx) > state.width * 0.18 || Math.abs(velocity) > 0.45;
    const next = passed ? index + (state.dx < 0 ? 1 : -1) : index;
    const clamped = Math.min(LAST, Math.max(0, next));
    if (clamped === index) paint(index, 0, true);
    else go(clamped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") go(index + 1);
    else if (event.key === "ArrowLeft") go(index - 1);
    else return;
    event.preventDefault();
  };

  const current = SLIDES[index] ?? SLIDES[0];

  return (
    <main className={styles.screen}>
      <span className={styles.ambient} aria-hidden="true" />
      <header className={styles.top}>
        <ThenceMark size={30} />
        {index < LAST ? (
          <button type="button" className={styles.skip} onClick={finish}>
            Skip
          </button>
        ) : (
          <span className={styles.skipSpacer} aria-hidden="true" />
        )}
      </header>

      <section
        className={styles.carousel}
        aria-roledescription="carousel"
        aria-label="Introduction to Thence"
      >
        <div
          className={styles.gesture}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="group"
          aria-label="Slides. Swipe, or use the left and right arrow keys."
        >
          <div className={styles.artViewport}>
            <div ref={artTrack} className={styles.track}>
              {SLIDES.map(({ id, Art }, i) => (
                <div
                  key={id}
                  className={styles.artSlide}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${SLIDES.length}`}
                  aria-hidden={i !== index}
                  inert={i !== index}
                  data-active={i === index}
                >
                  <Art active={i === index} />
                </div>
              ))}
            </div>
          </div>

          <div className={styles.copyViewport}>
            <div ref={copyTrack} className={styles.track}>
              {SLIDES.map((slide, i) => (
                <div key={slide.id} className={styles.copySlide} data-active={i === index} aria-hidden={i !== index}>
                  <h1 className={styles.headline}>{slide.title}</h1>
                  <p className={styles.body}>{slide.body}</p>
                  {slide.note ? <p className={styles.note}>{slide.note}</p> : null}
                </div>
              ))}
            </div>
          </div>
          <div className={styles.dots}>
            {SLIDES.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                className={styles.dot}
                data-active={i === index}
                aria-label={`Show slide ${i + 1} of ${SLIDES.length}`}
                aria-current={i === index ? "step" : undefined}
                onClick={() => go(i)}
              >
                <span />
              </button>
            ))}
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {`Slide ${index + 1} of ${SLIDES.length}: ${current.title}`}
        </p>
      </section>

      <footer className={styles.actions}>
        <div className={styles.backSlot} data-visible={index > 0}>
          <IconButton icon="arrow-left" label="Previous slide" onClick={() => go(index - 1)} disabled={index === 0} tabIndex={index === 0 ? -1 : 0} />
        </div>
        {index < LAST ? (
          <Button variant="light" block trailingIcon="arrow-right" onClick={() => go(index + 1)}>
            Next
          </Button>
        ) : (
          <Button variant="mint" block trailingIcon="arrow-right" onClick={finish}>
            Get started
          </Button>
        )}
      </footer>
    </main>
  );
}
