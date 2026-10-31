/**
 * F8.11 — no infinite spinner (pure, no DOM).
 *
 * A hung client-side read (locked IndexedDB, stalled SDK storage, thrown
 * sync error) used to leave the Send flow on "working" forever: run() had
 * try/finally but no catch, and storage reads had no timeouts. Now every
 * unexpected failure surfaces as a bounded, retryable error, and vault
 * reads time out into the normal retry path. Nothing is created or paid
 * on these paths.
 */
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/ui/lib/prepare-flow";
import { shouldDiscardBindingOnAttachFailure } from "@/ui/lib/recovery-vault";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withTimeout", () => {
  it("passes through fast results untouched", async () => {
    await expect(withTimeout(Promise.resolve(42), 50, "probe")).resolves.toBe(42);
  });

  it("rejects with a labeled error after the budget", async () => {
    const gate = deferred<number>();
    const start = Date.now();
    await expect(withTimeout(gate.promise, 20, "vault read")).rejects.toThrow("vault read timed out.");
    expect(Date.now() - start).toBeLessThan(1000);
    gate.resolve(1);
  });

  it("propagates the inner rejection instead of masking it as a timeout", async () => {
    const boom = new Error("storage gone");
    await expect(withTimeout(Promise.reject(boom), 1000, "probe")).rejects.toBe(boom);
  });

  it("does not fire the timer after settlement", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve("ok"), 5000, "probe");
    await new Promise((r) => setTimeout(r, 30));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("shouldDiscardBindingOnAttachFailure", () => {
  it("drops the vault binding only on server-verified invoice expiry", () => {
    expect(shouldDiscardBindingOnAttachFailure("INVOICE_EXPIRED")).toBe(true);
  });

  it("keeps the binding for every other attach outcome", () => {
    for (const code of [null, "", "SWAP_MISMATCH", "SWAP_NOT_FOUND", "SWAP_CONFLICT", "VERSION_CONFLICT", "NOT_ATTACHABLE", "PROVIDER_TIMEOUT", "TIMEOUT", "invoice_expired"]) {
      expect(shouldDiscardBindingOnAttachFailure(code)).toBe(false);
    }
  });
});
