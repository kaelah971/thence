import { afterEach, describe, expect, it } from "vitest";
import { loadActivityArchive, setActivityArchived } from "@/ui/lib/activity-archive";

function fakeLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("Activity dismissal is presentation-only", () => {
  it("archives per owner without changing transfer state", () => {
    fakeLocalStorage();
    expect(loadActivityArchive("owner-a").has("transfer-1")).toBe(false);
    expect(setActivityArchived("owner-a", "transfer-1", true).has("transfer-1")).toBe(true);
    expect(loadActivityArchive("owner-a").has("transfer-1")).toBe(true);
    expect(loadActivityArchive("owner-b").has("transfer-1")).toBe(false);
    expect(setActivityArchived("owner-a", "transfer-1", false).has("transfer-1")).toBe(false);
  });
});
