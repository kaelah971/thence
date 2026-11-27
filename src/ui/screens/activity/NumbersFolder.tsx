"use client";

import { useState } from "react";
import styles from "./numbers-folder.module.css";

/**
 * "Thence in numbers" as a glass folder: three cards stand in it with their
 * numbers showing above the pocket. Tapping a card lifts it and the pocket
 * explains what that number counts. Decorative counters only: they never
 * block the screen and show "—" until /api/stats answers.
 */
export interface ThenceStats {
  people: number;
  payers: number;
}

type CardKey = "people" | "payers" | "nim";

export function NumbersFolder({ stats, nimTotal }: { stats: ThenceStats | null; nimTotal: string }) {
  const [open, setOpen] = useState<CardKey | null>(null);
  const people = stats ? String(stats.people) : "—";
  const payers = stats ? String(stats.payers) : "—";
  const cards: Array<{ key: CardKey; value: string; label: string; detail: string }> = [
    {
      key: "people",
      value: people,
      label: "People",
      detail: stats ? `${people} people have signed in to Thence with Nimiq Pay.` : "People who have signed in to Thence with Nimiq Pay.",
    },
    {
      key: "payers",
      value: payers,
      label: "Wallets paying",
      detail: stats ? `${payers} of them have started at least one payment.` : "Wallets that have started at least one payment.",
    },
    {
      key: "nim",
      value: nimTotal,
      label: "NIM received",
      detail: nimTotal === "—" ? "NIM paid into Thence and verified on the Nimiq chain." : `${nimTotal} NIM paid into Thence and verified on the Nimiq chain.`,
    },
  ];
  const active = cards.find((c) => c.key === open) ?? null;

  return (
    <section className={styles.folder} aria-label="Thence in numbers">
      <span className={styles.back} aria-hidden="true" />
      <div className={styles.deck}>
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={styles.card}
            data-card={card.key}
            aria-pressed={open === card.key}
            aria-label={`${card.value} ${card.label}. ${card.detail}`}
            onClick={() => setOpen((current) => (current === card.key ? null : card.key))}
          >
            <span className={styles.cardValue}>{card.value}</span>
            <span className={styles.cardLabel}>{card.label}</span>
          </button>
        ))}
      </div>
      <div className={styles.pocket}>
        <div className={styles.pocketHead}>
          <h2 className={styles.title}>Thence in numbers</h2>
          <span className={styles.live}>
            <span className={styles.dot} aria-hidden="true" />
            Live
          </span>
        </div>
        <p className={styles.hint} aria-live="polite">
          {active ? active.detail : "Tap a card to see what it counts."}
        </p>
      </div>
    </section>
  );
}
