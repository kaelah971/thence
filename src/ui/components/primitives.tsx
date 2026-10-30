"use client";

import { useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import type { TransferStatus } from "@/domain/transfers";
import type { AvatarTone } from "@/ui/fixtures/preview";
import { cn } from "@/ui/lib/cn";
import { pillLabel, STAGE_OF } from "@/ui/lib/status";
import { Icon, type IconName } from "./Icon";
import styles from "./primitives.module.css";

/* ---------- Text field ---------- */
interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label: string;
  hint?: string;
  error?: string | null;
  inputClassName?: string | undefined;
  className?: string | undefined;
}

export function TextField({ label, hint, error, inputClassName, className, id, ...rest }: TextFieldProps): React.JSX.Element {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className={cn(styles.field, className)}>
      <label htmlFor={fieldId} className={styles.fieldLabel}>
        {label}
      </label>
      <input
        id={fieldId}
        className={cn(styles.input, inputClassName)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...rest}
      />
      {error ? (
        <p id={errorId} className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className={styles.fieldHint}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function SearchField({ label, ...rest }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">): React.JSX.Element {
  return (
    <div className={styles.search}>
      <Icon name="search" size={18} className={styles.searchIcon} />
      <input type="search" aria-label={label} className={styles.input} autoComplete="off" enterKeyHint="search" {...rest} />
    </div>
  );
}

/* ---------- Segmented control (radio group) ---------- */
interface SegmentedProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  tone?: "light" | "dark";
  className?: string | undefined;
}

export function Segmented<T extends string>({ label, options, value, onChange, tone = "light", className }: SegmentedProps<T>): React.JSX.Element {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(index + delta + options.length) % options.length];
    if (next) {
      onChange(next.value);
      const group = event.currentTarget;
      requestAnimationFrame(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
    }
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn(styles.segmented, tone === "dark" && styles.segmentedDark, className)} onKeyDown={onKeyDown}>
      <span
        aria-hidden="true"
        className={styles.segmentThumb}
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={styles.segment}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Filter chips ---------- */
interface ChipsProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}

export function FilterChips<T extends string>({ label, options, value, onChange }: ChipsProps<T>): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={styles.chipRow}>
      {options.map((option) => (
        <button key={option.value} type="button" className={styles.chip} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Status pill ---------- */
export function StatusPill({ status }: { status: TransferStatus }): React.JSX.Element {
  const stage = STAGE_OF[status];
  return (
    <span className={cn(styles.status, styles[`st-${stage}`])}>
      <span className={styles.statusDot} aria-hidden="true" />
      {pillLabel(status)}
    </span>
  );
}

/* ---------- Avatar ---------- */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "·";
}

interface AvatarProps {
  name: string;
  tone?: AvatarTone | "ink";
  size?: number;
  verified?: boolean;
  className?: string | undefined;
}

export function Avatar({ name, tone = "mint", size = 48, verified = false, className }: AvatarProps): React.JSX.Element {
  return (
    <span className={cn(styles.avatarWrap, className)}>
      <span className={cn(styles.avatar, styles[`tone-${tone}`])} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
        {initialsOf(name)}
      </span>
      {verified && (
        <span className={styles.avatarBadge} title="Wallet verified">
          <Icon name="check" size={11} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

/* ---------- Tags ---------- */
export function PreviewTag({ tone = "light", children = "Preview" }: { tone?: "light" | "dark"; children?: ReactNode }): React.JSX.Element {
  return (
    <span className={cn(styles.previewTag, tone === "dark" && styles.previewTagDark)}>
      <Icon name="eye" size={12} strokeWidth={2.2} />
      {children}
    </span>
  );
}

export function IllustrationTag({ children = "Illustration" }: { children?: ReactNode }): React.JSX.Element {
  return <span className={styles.illustrationTag}>{children}</span>;
}

/* ---------- Empty state ---------- */
interface EmptyStateProps {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyArt}>
        <Icon name={icon} size={26} />
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyBody}>{body}</p>
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

/* ---------- Skeleton ---------- */
export function Skeleton({ width, height, radius }: { width: number | string; height: number; radius?: number }): React.JSX.Element {
  return <span className={styles.skeleton} style={{ display: "block", width, height, borderRadius: radius }} aria-hidden="true" />;
}

/* ---------- Notice ---------- */
interface NoticeProps {
  tone?: "info" | "warn" | "error" | "dark";
  icon?: IconName;
  title?: string;
  children: ReactNode;
  live?: boolean;
}

export function Notice({ tone = "info", icon = "info", title, children, live = false }: NoticeProps): React.JSX.Element {
  return (
    <div className={cn(styles.notice, styles[`n-${tone}`])} role={live ? "status" : undefined}>
      <Icon name={icon} size={18} />
      <div>
        {title && <p className={styles.noticeTitle}>{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}
