"use client";

import { useSyncExternalStore } from "react";

/**
 * Small browser-storage stores for F1.
 *
 * - Intro hint (localStorage): "the tour was completed on this device".
 *   A convenience only — not an account, not a session.
 * - Setup name (sessionStorage): temporary until F2 saves it to the
 *   authenticated profile. Cleared when the tab closes.
 * - Preview mode (sessionStorage): development-only fixture display.
 *
 * Server snapshots return `undefined` so the first client render matches
 * the server HTML (no hydration mismatch); real values arrive right after.
 */

type Area = "local" | "session";

const KEYS = {
  introSeen: { area: "local", key: "thence.f1.introSeen" },
  setupName: { area: "session", key: "thence.f1.setupName" },
  preview: { area: "session", key: "thence.f1.preview" },
  signedIn: { area: "local", key: "thence.f2.signedInHint" },
} as const satisfies Record<string, { area: Area; key: string }>;

type StoreKey = keyof typeof KEYS;

const listeners = new Set<() => void>();

function storageFor(area: Area): Storage | null {
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(name: StoreKey): string | null {
  const { area, key } = KEYS[name];
  return storageFor(area)?.getItem(key) ?? null;
}

function write(name: StoreKey, value: string | null): void {
  const { area, key } = KEYS[name];
  const storage = storageFor(area);
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* Storage can be unavailable in private WebViews; the flow still works in memory. */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** `undefined` while hydrating, then the stored string or null. */
function useStored(name: StoreKey): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => read(name),
    () => undefined,
  );
}

export function useIntroSeen(): boolean | undefined {
  const value = useStored("introSeen");
  return value === undefined ? undefined : value === "1";
}

export function markIntroSeen(): void {
  write("introSeen", "1");
}

export function useSetupName(): string | null | undefined {
  return useStored("setupName");
}

export function saveSetupName(name: string): void {
  write("setupName", name.trim().slice(0, NAME_MAX));
}

export function resetDeviceSetup(): void {
  write("introSeen", null);
  write("setupName", null);
  write("signedIn", null);
}

export function clearSetupName(): void {
  write("setupName", null);
}

/** Read the temporary name outside React (e.g. right after sign-in). */
export function readSetupName(): string | null {
  return typeof window === "undefined" ? null : read("setupName");
}

/**
 * "This device has signed in before." A presentation hint only — it turns a
 * 401 into the short reconnect screen instead of the tour. Never a token,
 * never proof of identity.
 */
export function readSignedInHint(): boolean {
  return typeof window !== "undefined" && read("signedIn") === "1";
}

export function setSignedInHint(on: boolean): void {
  write("signedIn", on ? "1" : null);
}

export const NAME_MAX = 32;

/** Preview fixtures are only ever honoured in development builds. */
export const PREVIEW_ALLOWED = process.env.NODE_ENV !== "production";

export function usePreviewMode(): boolean {
  return usePreviewState() === true;
}

/** `undefined` while hydrating, so screens can show a skeleton instead of flashing the wrong state. */
export function usePreviewState(): boolean | undefined {
  const value = useStored("preview");
  if (value === undefined) return undefined;
  return PREVIEW_ALLOWED && value === "1";
}

export function setPreviewMode(on: boolean): void {
  if (!PREVIEW_ALLOWED) return;
  write("preview", on ? "1" : null);
}
