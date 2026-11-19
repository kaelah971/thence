import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDeskOwner, deskConfig } from "@/lib/desk/config";
import { deskChainConfig } from "@/lib/desk/chains";
import { fixtureWallet } from "./helpers";

const listed = fixtureWallet().address;
const stranger = fixtureWallet().address;

function stage(extra: Record<string, string> = {}) {
  vi.stubEnv("THENCE_DESK_NIM_ADDRESS", listed);
  vi.stubEnv("THENCE_DESK_POLYGON_ADDRESS", "0x21e5fc03e4305cc8cfb874253c6d66a8bdb0bcda");
  vi.stubEnv("THENCE_DESK_POLYGON_RPC", "https://polygon.test");
  vi.stubEnv("THENCE_NIMIQ_PROOF_RPC_URL", "https://nimiq.test");
  vi.stubEnv("THENCE_DESK_OWNER_ADDRESSES", listed);
  vi.stubEnv("THENCE_DESK_ENABLED", "true");
  vi.stubEnv("THENCE_DESK_OPEN", "false");
  vi.stubEnv("THENCE_DESK_MAX_USDC_ATOMIC", "5000000");
  vi.stubEnv("THENCE_DESK_FEE_BPS", "50");
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("treasury desk access mode", () => {
  it("closed mode admits only listed wallets", () => {
    stage();
    expect(assertDeskOwner(listed).open).toBe(false);
    expect(() => assertDeskOwner(stranger)).toThrow(/not enabled for this wallet/i);
  });

  it("open mode admits any valid signed-in wallet, listed or not", () => {
    stage({ THENCE_DESK_OPEN: "true", THENCE_DESK_OWNER_ADDRESSES: "" });
    const config = assertDeskOwner(stranger);
    expect(config.open).toBe(true);
    expect(config.enabled).toBe(true);
  });

  it("open mode still refuses new funding while paused", () => {
    stage({ THENCE_DESK_OPEN: "true", THENCE_DESK_ENABLED: "false" });
    expect(() => assertDeskOwner(stranger)).not.toThrow();
    expect(() => assertDeskOwner(stranger, true)).toThrow(/paused/i);
  });

  it("keeps fat-finger bounds on both ends", () => {
    stage({ THENCE_DESK_MAX_USDC_ATOMIC: "1000000000" });
    expect(deskConfig().minAtomic).toBe(10_000n);
    expect(deskConfig().maxAtomic).toBe(1_000_000_000n);
    stage({ THENCE_DESK_MAX_USDC_ATOMIC: "1000000001" });
    expect(() => deskConfig()).toThrow(/invalid pilot limits/i);
    stage({ THENCE_DESK_MIN_USDC_ATOMIC: "9999" });
    expect(() => deskConfig()).toThrow(/invalid pilot limits/i);
    stage({ THENCE_DESK_MIN_USDC_ATOMIC: "20000", THENCE_DESK_MAX_USDC_ATOMIC: "10000" });
    expect(() => deskConfig()).toThrow(/invalid pilot limits/i);
  });

  it("maps each desk chain to its own USDC, gas symbol and finality RPC", () => {
    stage({ THENCE_DESK_ARBITRUM_RPC: "https://arbitrum.test", THENCE_DESK_BASE_RPC: "https://base.test" });
    expect(deskChainConfig("polygon")).toMatchObject({ chainId: 137, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", gasSymbol: "POL" });
    expect(deskChainConfig("arbitrum")).toMatchObject({ chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", gasSymbol: "ETH" });
    expect(deskChainConfig("base")).toMatchObject({ chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", gasSymbol: "ETH" });
    vi.stubEnv("THENCE_DESK_ARBITRUM_RPC", "");
    expect(() => deskChainConfig("arbitrum")).toThrow(/not configured/i);
  });
});
