/**
 * F4.1 — durable browser recovery vault (client-only).
 *
 * What this stores: a PUBLIC binding record that links a Thence transfer to
 * the Satora swap the browser created for it. It never stores preimages,
 * mnemonics, secret keys or any SDK recovery secret — those stay inside the
 * Satora SDK's own IndexedDB (`lendaswap-v3`, owned by @satora/swap).
 *
 * Why two stores: the SDK persists the secrets; this vault persists the
 * binding (which transfer + which swap + which wallet, verified by readback).
 * Attach requires both: SDK readback proves the secrets survived, vault
 * readback proves the binding is intact and belongs to this user/transfer.
 *
 * Security (explicit, shown in the UI too): browser storage is NOT secure
 * against XSS, device loss or eviction. A missing vault entry STOPS the flow
 * before any payment approval — it never silently creates a new swap.
 */

export const RECOVERY_VAULT_VERSION = 1;
const DB_NAME = "thence-recovery";
const DB_VERSION = 1;
const STORE = "bindings";

export interface RecoveryBinding {
  version: number;
  transferId: string;
  satoraSwapId: string;
  paymentHash: string;
  sourceSats: string | null;
  targetAtomic: string;
  destination: string;
  routeId: string;
  quoteRevision: number;
  ownerUserId: string;
  /** Opaque attempt handle for attach/authorize (owner-scoped, not a payment capability). */
  attemptToken: string;
  storedAt: string;
  verifiedAt: string | null;
}

export type VaultLoadResult =
  | { status: "ok"; binding: RecoveryBinding }
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "foreign" }
  | { status: "incompatible"; reason: string }
  | { status: "unavailable"; reason: string };

const ATOMIC_RE = /^[1-9][0-9]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pure validation: missing vs corrupt vs incompatible vs foreign. */
export function validateBinding(
  raw: unknown,
  opts: { transferId: string; ownerUserId: string },
): VaultLoadResult {
  if (raw === null || raw === undefined) return { status: "missing" };
  if (!isRecord(raw)) return { status: "corrupt", reason: "Binding is not an object." };
  const version = raw["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { status: "corrupt", reason: "Binding has no schema version." };
  }
  if (version !== RECOVERY_VAULT_VERSION) {
    return { status: "incompatible", reason: `Binding version ${String(version)} is not supported.` };
  }
  const get = (k: string): unknown => raw[k];
  const transferId = get("transferId");
  const satoraSwapId = get("satoraSwapId");
  const paymentHash = get("paymentHash");
  const targetAtomic = get("targetAtomic");
  const destination = get("destination");
  const routeId = get("routeId");
  const quoteRevision = get("quoteRevision");
  const ownerUserId = get("ownerUserId");
  const attemptToken = get("attemptToken");
  if (
    typeof transferId !== "string" ||
    typeof satoraSwapId !== "string" ||
    typeof paymentHash !== "string" ||
    typeof targetAtomic !== "string" ||
    typeof destination !== "string" ||
    typeof routeId !== "string" ||
    typeof ownerUserId !== "string" ||
    typeof quoteRevision !== "number" ||
    typeof attemptToken !== "string"
  ) {
    return { status: "corrupt", reason: "Binding is missing required fields." };
  }
  if (attemptToken.length === 0 || attemptToken.length > 512) {
    return { status: "corrupt", reason: "Binding has a bad attempt handle." };
  }
  if (transferId.length === 0 || transferId.length > 128) return { status: "corrupt", reason: "Binding has a bad transfer id." };
  if (satoraSwapId.length === 0 || satoraSwapId.length > 128) return { status: "corrupt", reason: "Binding has a bad swap id." };
  if (paymentHash.length === 0 || paymentHash.length > 256) return { status: "corrupt", reason: "Binding has a bad payment hash." };
  if (!ATOMIC_RE.test(targetAtomic)) return { status: "corrupt", reason: "Binding has a bad target amount." };
  if (destination.length === 0 || destination.length > 256) return { status: "corrupt", reason: "Binding has a bad destination." };
  if (routeId.length === 0 || routeId.length > 64) return { status: "corrupt", reason: "Binding has a bad route." };
  if (!Number.isInteger(quoteRevision) || quoteRevision < 1) return { status: "corrupt", reason: "Binding has a bad quote revision." };
  const sourceSats = get("sourceSats");
  if (sourceSats !== null && (typeof sourceSats !== "string" || !ATOMIC_RE.test(sourceSats))) {
    return { status: "corrupt", reason: "Binding has a bad source amount." };
  }
  // Cross-user leak guard: a binding owned by someone else is never returned.
  if (ownerUserId !== opts.ownerUserId) return { status: "foreign" };
  if (transferId !== opts.transferId) return { status: "corrupt", reason: "Binding belongs to a different transfer." };
  return {
    status: "ok",
    binding: {
      version,
      transferId,
      satoraSwapId,
      paymentHash,
      sourceSats: (sourceSats as string | null) ?? null,
      targetAtomic,
      destination,
      routeId,
      quoteRevision,
      ownerUserId,
      attemptToken,
      storedAt: typeof get("storedAt") === "string" ? (get("storedAt") as string) : new Date(0).toISOString(),
      verifiedAt: typeof get("verifiedAt") === "string" ? (get("verifiedAt") as string) : null,
    },
  };
}

function idbAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

/** Public gate: when false the caller must STOP before payment approval. */
export function isVaultAvailable(): boolean {
  try {
    return idbAvailable();
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "transferId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open recovery vault."));
    request.onblocked = () => reject(new Error("Recovery vault is blocked by another tab."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Recovery vault write failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Recovery vault write aborted."));
  });
}

/**
 * Persist BEFORE proceeding. The write is verified by an immediate readback
 * in `saveAndVerifyBinding` — callers should prefer that helper.
 */
export async function saveBinding(binding: RecoveryBinding): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...binding });
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function loadRawBinding(transferId: string): Promise<unknown> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(transferId);
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("Recovery vault read failed."));
    });
    await txDone(tx).catch(() => undefined);
    return value;
  } finally {
    db.close();
  }
}

export async function clearBinding(transferId: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(transferId);
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // Clearing is best-effort; a failed delete never blocks safe retry.
  }
}

/** Persist then read back and verify integrity. Fails closed on any mismatch. */
export async function saveAndVerifyBinding(binding: RecoveryBinding): Promise<VaultLoadResult> {
  if (!isVaultAvailable()) return { status: "unavailable", reason: "Durable storage is unavailable in this browser." };
  try {
    await saveBinding(binding);
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Could not save recovery information." };
  }
  let raw: unknown;
  try {
    raw = await loadRawBinding(binding.transferId);
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Could not read back recovery information." };
  }
  const checked = validateBinding(raw, { transferId: binding.transferId, ownerUserId: binding.ownerUserId });
  if (checked.status !== "ok") return checked;
  const roundTripped = checked.binding;
  if (
    roundTripped.satoraSwapId !== binding.satoraSwapId ||
    roundTripped.paymentHash.toLowerCase() !== binding.paymentHash.toLowerCase() ||
    roundTripped.targetAtomic !== binding.targetAtomic ||
    roundTripped.destination.toLowerCase() !== binding.destination.toLowerCase() ||
    roundTripped.routeId !== binding.routeId
  ) {
    return { status: "corrupt", reason: "Recovery information did not round-trip intact." };
  }
  return checked;
}

export async function loadBinding(transferId: string, ownerUserId: string): Promise<VaultLoadResult> {
  if (!isVaultAvailable()) return { status: "unavailable", reason: "Durable storage is unavailable in this browser." };
  let raw: unknown;
  try {
    raw = await loadRawBinding(transferId);
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : "Could not read recovery information." };
  }
  return validateBinding(raw, { transferId, ownerUserId });
}

/* ---------- in-memory vault (tests + non-IndexedDB fallback seam) ---------- */

export interface VaultLike {
  available: boolean;
  saveAndVerify(binding: RecoveryBinding): Promise<VaultLoadResult>;
  load(transferId: string, ownerUserId: string): Promise<VaultLoadResult>;
  clear(transferId: string): Promise<void>;
}

export function createMemoryVault(): VaultLike & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    available: true,
    async saveAndVerify(binding: RecoveryBinding): Promise<VaultLoadResult> {
      records.set(binding.transferId, { ...binding });
      return validateBinding(records.get(binding.transferId), { transferId: binding.transferId, ownerUserId: binding.ownerUserId });
    },
    async load(transferId: string, ownerUserId: string): Promise<VaultLoadResult> {
      return validateBinding(records.has(transferId) ? records.get(transferId) : null, { transferId, ownerUserId });
    },
    async clear(transferId: string): Promise<void> {
      records.delete(transferId);
    },
  };
}

export function createUnavailableVault(reason = "Durable storage is unavailable in this browser."): VaultLike {
  return {
    available: false,
    async saveAndVerify(): Promise<VaultLoadResult> {
      return { status: "unavailable", reason };
    },
    async load(): Promise<VaultLoadResult> {
      return { status: "unavailable", reason };
    },
    async clear(): Promise<void> {},
  };
}
