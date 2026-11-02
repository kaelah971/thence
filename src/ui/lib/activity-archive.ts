"use client";

/** Local Activity presentation state only. It never changes transfer state. */
export const ACTIVITY_ARCHIVE_KEY = "thence.activity.archive.v1";
const MAX_ARCHIVED_IDS = 500;

type ArchiveIndex = Record<string, string[]>;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readIndex(store: Storage): ArchiveIndex {
  try {
    const parsed = JSON.parse(store.getItem(ACTIVITY_ARCHIVE_KEY) ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: ArchiveIndex = {};
    for (const [owner, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) result[owner] = ids.filter((id): id is string => typeof id === "string").slice(-MAX_ARCHIVED_IDS);
    }
    return result;
  } catch {
    return {};
  }
}

function writeIndex(store: Storage, index: ArchiveIndex): void {
  store.setItem(ACTIVITY_ARCHIVE_KEY, JSON.stringify(index));
}

export function loadActivityArchive(ownerUserId: string | null): ReadonlySet<string> {
  if (!ownerUserId) return new Set();
  const store = storage();
  if (!store) return new Set();
  return new Set(readIndex(store)[ownerUserId] ?? []);
}

export function setActivityArchived(ownerUserId: string | null, transferId: string, archived: boolean): ReadonlySet<string> {
  if (!ownerUserId || !transferId) return new Set();
  const store = storage();
  if (!store) return new Set();
  const index = readIndex(store);
  const ids = new Set(index[ownerUserId] ?? []);
  if (archived) ids.add(transferId);
  else ids.delete(transferId);
  index[ownerUserId] = [...ids].slice(-MAX_ARCHIVED_IDS);
  writeIndex(store, index);
  return new Set(index[ownerUserId]);
}
