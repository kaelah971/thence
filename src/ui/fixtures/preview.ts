/**
 * PREVIEW FIXTURES — design presentation only.
 *
 * Fictional people and payments used by the development preview route
 * (/app/preview). They are never shown in normal unauthenticated screens,
 * never sent to the backend, and every screen that renders them carries a
 * visible "Preview data" label. No real balances, rates or deliveries.
 */

import type { RouteId } from "@/domain/routes";
import type { TransferStatus } from "@/domain/transfers";

export type AvatarTone = "mint" | "sky" | "sun" | "coral" | "sand";

interface PreviewBrand {
  readonly preview: true;
}

export interface PreviewRecipient extends PreviewBrand {
  id: string;
  name: string;
  tone: AvatarTone;
  routeId: RouteId;
  address: string;
  /** True only where the fixture models a backend-verified wallet proof. */
  walletVerified: boolean;
  note: string | null;
}

export interface PreviewTransfer extends PreviewBrand {
  id: string;
  recipientId: string;
  routeId: RouteId;
  /** Exact receiving amount, human decimal string. */
  amount: string;
  status: TransferStatus;
  dayLabel: string;
  timeLabel: string;
}

export const PREVIEW_RECIPIENTS: readonly PreviewRecipient[] = [
  { preview: true, id: "p-alex", name: "Alex Moreno", tone: "mint", routeId: "usdc-polygon", address: "0x4f2a9C1e7b3D8a0F6c5E2d1B9a8C7f6E5d4C3b21", walletVerified: true, note: "Studio rent share" },
  { preview: true, id: "p-mina", name: "Mina Okafor", tone: "sky", routeId: "usdc-arbitrum", address: "0x9a1B2c3D4e5F60718293a4B5c6D7e8F9012a3B4c", walletVerified: false, note: null },
  { preview: true, id: "p-joon", name: "Joon Park", tone: "sun", routeId: "usdc-ethereum", address: "0x1D2e3F4a5B6c7D8e9F0a1B2c3D4e5F6a7B8c9D0e", walletVerified: true, note: null },
  { preview: true, id: "p-sofia", name: "Sofia Lind", tone: "coral", routeId: "usdc-polygon", address: "0x7E6d5C4b3A29180f7E6d5C4b3A29180f7E6d5C4b", walletVerified: false, note: "Design invoice" },
  { preview: true, id: "p-tomas", name: "Tomás Reyes", tone: "sand", routeId: "btc-lightning", address: "tomas@walletofsatoshi.example", walletVerified: false, note: null },
  { preview: true, id: "p-ines", name: "Inès Dubois", tone: "mint", routeId: "usdc-arbitrum", address: "0x3c4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a0B1c2D", walletVerified: true, note: null },
];

export const PREVIEW_TRANSFERS: readonly PreviewTransfer[] = [
  { preview: true, id: "t-1", recipientId: "p-alex", routeId: "usdc-polygon", amount: "25", status: "SERVER_FUNDED", dayLabel: "Today", timeLabel: "14:20" },
  { preview: true, id: "t-2", recipientId: "p-mina", routeId: "usdc-arbitrum", amount: "120.5", status: "RECONCILING", dayLabel: "Today", timeLabel: "09:02" },
  { preview: true, id: "t-3", recipientId: "p-joon", routeId: "usdc-ethereum", amount: "60", status: "AWAITING_NIM_APPROVAL", dayLabel: "Today", timeLabel: "08:41" },
  { preview: true, id: "t-4", recipientId: "p-sofia", routeId: "usdc-polygon", amount: "340", status: "DELIVERED", dayLabel: "Yesterday", timeLabel: "18:15" },
  { preview: true, id: "t-5", recipientId: "p-tomas", routeId: "btc-lightning", amount: "0.00042", status: "NEEDS_ATTENTION", dayLabel: "Yesterday", timeLabel: "11:30" },
  { preview: true, id: "t-6", recipientId: "p-ines", routeId: "usdc-arbitrum", amount: "15", status: "QUOTE_EXPIRED", dayLabel: "Mon 26 Oct", timeLabel: "16:48" },
];

export function previewRecipient(id: string): PreviewRecipient | undefined {
  return PREVIEW_RECIPIENTS.find((r) => r.id === id);
}
