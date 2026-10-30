"use client";

import { useState } from "react";
import type { ActivityItem, RecipientItem } from "@/ui/components/rows";
import { PREVIEW_RECIPIENTS, PREVIEW_TRANSFERS, previewRecipient } from "@/ui/fixtures/preview";
import type { ApiResult } from "./api";
import { listRecipients, toRecipientView, type RecipientPage } from "./recipients-api";
import { useApiResource } from "./resource";
import { useSession } from "./session";
import { usePreviewState } from "./stores";
import { listTransfers, toActivityItem, type TransferPage } from "./transfers-api";

/**
 * Screen data. In normal runtime this is ONLY the signed-in user's data
 * from the API (keys include the user id, so nothing survives a sign-out or
 * account change). Development preview fixtures are a separate branch and
 * never mix with real data.
 */
export type DataState<T> =
  | { status: "loading" }
  | { status: "disconnected" }
  | { status: "error"; message: string; retry: () => void }
  | {
      status: "ready";
      items: readonly T[];
      preview: boolean;
      total: number;
      hasMore: boolean;
      loadMore: () => void;
      refreshing: boolean;
      refresh: () => void;
    };

export const PAGE_SIZE = 50;

const PREVIEW_ACTIVITY: readonly ActivityItem[] = PREVIEW_TRANSFERS.map((t) => {
  const person = previewRecipient(t.recipientId);
  return {
    id: t.id,
    name: person?.name ?? "Recipient",
    tone: person?.tone ?? "mint",
    routeId: t.routeId,
    amount: t.amount,
    status: t.status,
    dayLabel: t.dayLabel,
    timeLabel: t.timeLabel,
  };
});

const noop = () => {};

function previewState<T>(items: readonly T[]): DataState<T> {
  return { status: "ready", items, preview: true, total: items.length, hasMore: false, loadMore: noop, refreshing: false, refresh: noop };
}

/** Load pages 1..n and merge, so "Show more" keeps earlier rows. */
async function loadPages<P, T>(
  pages: number,
  fetchPage: (page: number) => Promise<ApiResult<P>>,
  pick: (page: P) => { items: T[]; total: number },
): Promise<ApiResult<{ items: T[]; total: number }>> {
  const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchPage(i + 1)));
  const items: T[] = [];
  let total = 0;
  for (const result of results) {
    if (!result.ok) return result;
    const picked = pick(result.data);
    items.push(...picked.items);
    total = picked.total;
  }
  return { ok: true, status: 200, data: { items, total } };
}

function useOwnerKey(): { userId: string | null; checking: boolean; preview: boolean | undefined } {
  const session = useSession();
  const preview = usePreviewState();
  return {
    userId: session.status === "valid" ? session.me.user.id : null,
    checking: session.status === "unknown",
    preview,
  };
}

export interface RecipientQuery {
  q?: string;
  /** Include archived people (the API then returns active + archived). */
  archived?: boolean;
}

export function useRecipientData(query: RecipientQuery = {}): DataState<RecipientItem> {
  const { userId, checking, preview } = useOwnerKey();
  const [pages, setPages] = useState(1);
  const q = query.q?.trim() ?? "";
  const archived = Boolean(query.archived);
  const key = preview === false && userId ? `recipients:${userId}:${q}:${archived}:${pages}` : null;
  const resource = useApiResource(key, (signal) =>
    loadPages<RecipientPage, RecipientItem>(
      pages,
      (page) => listRecipients({ q, archived, page, pageSize: PAGE_SIZE }, { signal }),
      (page) => ({ items: page.recipients.map(toRecipientView), total: page.total }),
    ),
  );

  if (preview === undefined) return { status: "loading" };
  if (preview) {
    const needle = q.toLowerCase();
    return previewState(PREVIEW_RECIPIENTS.filter((r) => r.name.toLowerCase().includes(needle)));
  }
  if (!userId) return checking ? { status: "loading" } : { status: "disconnected" };
  if (resource.status === "error") return { status: "error", message: resource.message, retry: resource.retry };
  if (resource.status !== "ready") return { status: "loading" };
  const { items, total } = resource.data;
  return {
    status: "ready",
    items,
    preview: false,
    total,
    hasMore: items.length < total,
    loadMore: () => setPages((n) => n + 1),
    refreshing: resource.refreshing,
    refresh: resource.refresh,
  };
}

export function useActivityData(): DataState<ActivityItem> {
  const { userId, checking, preview } = useOwnerKey();
  const [pages, setPages] = useState(1);
  const key = preview === false && userId ? `transfers:${userId}:${pages}` : null;
  const resource = useApiResource(key, (signal) =>
    loadPages<TransferPage, ActivityItem>(
      pages,
      (page) => listTransfers({ page, pageSize: PAGE_SIZE }, { signal }),
      (page) => {
        const now = new Date();
        return {
          items: page.transfers.map((t) => toActivityItem(t, now)).filter((i): i is ActivityItem => i !== null),
          total: page.total,
        };
      },
    ),
  );

  if (preview === undefined) return { status: "loading" };
  if (preview) return previewState(PREVIEW_ACTIVITY);
  if (!userId) return checking ? { status: "loading" } : { status: "disconnected" };
  if (resource.status === "error") return { status: "error", message: resource.message, retry: resource.retry };
  if (resource.status !== "ready") return { status: "loading" };
  const { items, total } = resource.data;
  return {
    status: "ready",
    items,
    preview: false,
    total,
    hasMore: pages * PAGE_SIZE < total,
    loadMore: () => setPages((n) => n + 1),
    refreshing: resource.refreshing,
    refresh: resource.refresh,
  };
}
