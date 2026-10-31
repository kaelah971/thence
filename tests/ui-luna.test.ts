import { describe, expect, it } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import { readNimBalance } from "@/ui/lib/balance";
import { formatLuna, parseLuna, shortNimiqAddress } from "@/ui/lib/luna";
import { HostUnavailableError, type HostProvider } from "@/ui/lib/nimiq-provider";

const ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const sign: HostProvider["sign"] = async () => ({ publicKey: "", signature: "" });

describe("Luna → NIM formatting (100,000 Luna = 1 NIM)", () => {
  it("converts exactly, without floating point", () => {
    expect(formatLuna(100_000n).text).toBe("1.00");
    expect(formatLuna(123_456_789n).text).toBe("1,234.56789");
    expect(formatLuna(150_000n).text).toBe("1.50");
    expect(formatLuna(1n).text).toBe("0.00001");
    expect(formatLuna(9_007_199_254_740_991n).text).toBe("90,071,992,547.40991");
  });

  it("marks a genuine zero", () => {
    const zero = formatLuna(0n);
    expect(zero.text).toBe("0.00");
    expect(zero.isZero).toBe(true);
  });

  it("rejects values that are not safe non-negative integers", () => {
    expect(parseLuna(100)).toBe(100n);
    expect(parseLuna(0)).toBe(0n);
    expect(parseLuna(-1)).toBeNull();
    expect(parseLuna(1.5)).toBeNull();
    expect(parseLuna(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(parseLuna("100")).toBeNull();
    expect(parseLuna({ error: { type: "NETWORK_ERROR", message: "x" } })).toBeNull();
  });

  it("shortens addresses for the card", () => {
    expect(shortNimiqAddress("NQ12 3456 7890 ABCD EFGH JKLM NPQR STUV XY12")).toBe("NQ12 3456 … XY12");
  });
});

describe("NIM balance via the provider", () => {
  it("loads a real balance for the given address", async () => {
    let asked = "";
    const state = await readNimBalance(async () => ({ sign, getBalance: async (a: string) => ((asked = a), 250_000) }), ADDRESS);
    expect(asked).toBe(ADDRESS);
    expect(state).toEqual({ status: "loaded", luna: 250_000n, basicLuna: 250_000n, vaultLuna: null, vaultUnknown: false, source: "host", network: null });
  });

  it("distinguishes zero from unavailable", async () => {
    expect(await readNimBalance(async () => ({ sign, getBalance: async () => 0 }), ADDRESS)).toEqual({ status: "loaded", luna: 0n, basicLuna: 0n, vaultLuna: null, vaultUnknown: false, source: "host", network: null });
    expect(await readNimBalance(async () => ({ sign }), ADDRESS)).toEqual({ status: "unavailable", reason: "host-outdated" });
    expect(
      await readNimBalance(async () => {
        throw new HostUnavailableError();
      }, ADDRESS),
    ).toEqual({ status: "unavailable", reason: "not-in-host" });
  });

  it("reports network errors as errors, never as zero", async () => {
    const state = await readNimBalance(
      async () => ({
        sign,
        getBalance: async () => {
          throw new NimiqProviderError("NETWORK_ERROR", "Consensus not established", -32000);
        },
      }),
      ADDRESS,
    );
    expect(state).toEqual({ status: "error", reason: "network" });
  });

  it("treats malformed provider results as failures", async () => {
    const state = await readNimBalance(async () => ({ sign, getBalance: async () => -5 }), ADDRESS);
    expect(state).toEqual({ status: "error", reason: "failed" });
  });
});
