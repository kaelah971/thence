/**
 * F7.3 wallet diagnostics: read-only, masked, consent-gated.
 *
 * Phase 1 compares both production balance sources (host `getBalance` +
 * server `/api/me/balance`) for the session's verified address without
 * listing accounts. Phase 2 lists other host wallets ONLY on explicit
 * user request. Fully mocked — no database, no network, no funds.
 */
import { describe, expect, it } from "vitest";
import { NimiqProviderError } from "@nimiq/mini-app-sdk";
import type { ChainOutcome } from "@/ui/lib/balance";
import type { HostProvider } from "@/ui/lib/nimiq-provider";
import {
  diagnoseSignedWallet,
  getActiveHostNetwork,
  guidanceForSigned,
  listOtherWallets,
  maskNimiqIdentity,
} from "@/ui/lib/wallet-diagnostics";

const SESSION = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const FUNDED = "NQ32 1111 2222 3333 4444 5555 6666 7777 8888";
const OTHER = "NQ50 9999 8888 7777 6666 5555 4444 3333 2222";

const sign: HostProvider["sign"] = async () => ({ publicKey: "", signature: "" });
const chainOk = (luna: bigint, network: "mainnet" | "testnet" = "mainnet") => async (): Promise<ChainOutcome> => ({
  ok: true,
  luna,
  basicLuna: luna,
  vaults: null,
  vaultsUnknown: false,
  network,
});
const chainOff = async (): Promise<ChainOutcome> => ({ ok: false, reason: "not-configured" });

function hostWith(balances: Record<string, number>, accounts: string[] = [SESSION]): () => Promise<HostProvider> {
  return async () => ({
    sign,
    listAccounts: async () => accounts,
    getBalance: async (address: string) => {
      if (!(address in balances)) return 0;
      return balances[address]!;
    },
  });
}

describe("F7.3 phase 1: both sources for the signed-in wallet, no listing", () => {
  it("confirms funds when host and server agree nonzero", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: hostWith({ [SESSION]: 250_000 }),
      readChain: chainOk(250_000n),
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(d.host).toMatchObject({ state: "loaded", luna: 250_000n });
    expect(d.chain).toMatchObject({ state: "loaded", luna: 250_000n, network: "mainnet" });
    expect(guidanceForSigned(d)).toBe("funds-confirmed");
  });

  it("reproduces the live case: outdated host, server reads 0 on mainnet", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: async () => ({ sign }),
      readChain: chainOk(0n),
      getHostNetwork: () => undefined,
      sessionAddress: SESSION,
    });
    expect(d.host.state).toBe("unsupported");
    expect(d.chain).toMatchObject({ state: "loaded", luna: 0n, network: "mainnet" });
    expect(guidanceForSigned(d)).toBe("empty-on-read-networks");
  });

  it("flags host/server disagreement instead of hiding it", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: hostWith({ [SESSION]: 5_000_000 }),
      readChain: chainOk(0n),
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(guidanceForSigned(d)).toBe("host-chain-disagree");
  });

  it("never reports a network failure as zero", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: async () => ({
        sign,
        getBalance: async () => {
          throw new NimiqProviderError("NETWORK_ERROR", "Consensus not established", -32000);
        },
      }),
      readChain: chainOff,
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(d.host).toMatchObject({ state: "error", luna: null, error: "network" });
    expect(guidanceForSigned(d)).toBe("read-error");
  });

  it("treats legacy resolved error responses as failures", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: async () => ({
        sign,
        getBalance: async () => ({ error: { type: "NETWORK_ERROR", message: "down" } }) as unknown as number,
      }),
      readChain: chainOff,
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(d.host.state).toBe("error");
    expect(d.host.luna).toBeNull();
  });

  it("surfaces the host network, including unknown older hosts", async () => {
    const testnet = await diagnoseSignedWallet({
      getProvider: hostWith({ [SESSION]: 0 }),
      readChain: chainOk(0n, "mainnet"),
      getHostNetwork: () => "testnet",
      sessionAddress: SESSION,
    });
    expect(testnet.hostNetwork).toBe("testnet");
    expect(guidanceForSigned(testnet)).toBe("empty-on-read-networks");

    const unknown = await diagnoseSignedWallet({
      getProvider: hostWith({ [SESSION]: 0 }),
      readChain: chainOk(0n),
      getHostNetwork: () => undefined,
      sessionAddress: SESSION,
    });
    expect(unknown.hostNetwork).toBeNull();
    expect(unknown.networkUnknown).toBe(true);
  });

  it("needs no account list: phase 1 never calls listAccounts", async () => {
    let listed = false;
    const d = await diagnoseSignedWallet({
      getProvider: async () => ({
        sign,
        listAccounts: async () => {
          listed = true;
          return [SESSION];
        },
        getBalance: async () => 0,
      }),
      readChain: chainOk(0n),
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(listed).toBe(false);
    expect(d.host.state).toBe("loaded");
  });

  it("masks the session identity and handles sign-out", async () => {
    const d = await diagnoseSignedWallet({
      getProvider: hostWith({ [SESSION]: 0 }),
      readChain: chainOk(0n),
      getHostNetwork: () => "mainnet",
      sessionAddress: SESSION,
    });
    expect(d.sessionMasked).not.toContain(SESSION);
    expect(d.sessionMasked).toContain("…");
    expect(maskNimiqIdentity(SESSION)).toBe(d.sessionMasked);

    const out = await diagnoseSignedWallet({
      getProvider: hostWith({}),
      readChain: chainOk(0n),
      getHostNetwork: () => "mainnet",
      sessionAddress: null,
    });
    expect(guidanceForSigned(out)).toBe("signed-out");
  });
});

describe("F7.3 phase 2: other wallets only on explicit request", () => {
  it("finds funds in another wallet and detects a stale session", async () => {
    const stale = await listOtherWallets({
      getProvider: hostWith({ [FUNDED]: 5_000_000, [OTHER]: 0 }, [FUNDED, OTHER]),
      sessionAddress: SESSION,
    });
    expect(stale.state).toBe("ready");
    expect(stale.sessionInHost).toBe(false);
    expect(stale.others).toHaveLength(2);
    expect(stale.others.find((e) => e.luna === 5_000_000n)).toBeDefined();
  });

  it("confirms the session wallet is current when it is listed", async () => {
    const current = await listOtherWallets({
      getProvider: hostWith({ [SESSION]: 0, [OTHER]: 0 }, [SESSION, OTHER]),
      sessionAddress: SESSION,
    });
    expect(current.sessionInHost).toBe(true);
    // The session wallet itself is never duplicated into the others list.
    expect(current.others).toHaveLength(1);
    expect(current.others[0]!.masked).not.toContain(SESSION);
  });

  it("reports unsupported hosts without fabricating an empty list", async () => {
    const d = await listOtherWallets({ getProvider: async () => ({ sign }), sessionAddress: SESSION });
    expect(d).toEqual({ state: "unsupported", sessionInHost: null, others: [] });
  });

  it("keeps every returned identity masked and keyed safely", async () => {
    const d = await listOtherWallets({
      getProvider: hostWith({ [SESSION]: 0, [FUNDED]: 100_000 }, [SESSION, FUNDED]),
      sessionAddress: SESSION,
    });
    for (const e of d.others) {
      expect(e.key).not.toContain("NQ");
      expect(e.masked).not.toContain(FUNDED);
    }
  });
});

describe("F7.3 host network reader", () => {
  it("reads mainnet/testnet and fails closed", () => {
    expect(getActiveHostNetwork(() => "mainnet")).toBe("mainnet");
    expect(getActiveHostNetwork(() => "testnet")).toBe("testnet");
    expect(getActiveHostNetwork(() => "bogus")).toBeNull();
    expect(
      getActiveHostNetwork(() => {
        throw new Error("no window");
      }),
    ).toBeNull();
  });
});
