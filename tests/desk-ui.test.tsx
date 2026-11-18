// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "@/ui/screens/desk/Desk";
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const host = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@nimiq/mini-app-sdk", () => ({ getHostNetwork: () => "mainnet" }));
vi.mock("@/ui/lib/nimiq-provider", () => ({ getHostProvider: async () => ({ sendBasicTransactionWithData: host.send }) }));
const quoted = { id: "a4ee4c38-9bc4-4e3d-a89d-72cf6cab609c", state: "QUOTED", amountAtomic: "300000", recipient: "0x1111111111111111111111111111111111111111", nimAddress: "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ", nimLuna: "30150000", feeLuna: "150000", feeBps: 50, memo: "THENCE:D:payment", expiresAt: new Date(Date.now() + 60000).toISOString(), reportedHash: null };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("treasury pilot screen", () => {
  it("shows an existing funded payment without offering another wallet prompt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: true, orders: [{ ...quoted, state: "AWAITING_NIM" }] })));
    render(<Desk />);
    await screen.findByText(/Checking for your NIM payment/);
    expect(screen.queryByRole("button", { name: "Continue in Nimiq Pay" })).toBeNull();
    expect(host.send).not.toHaveBeenCalled();
  });
  it("requires custody consent and prompts once even when the wallet response fails", async () => {
    let order = { ...quoted };
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.body) return Response.json({ enabled: true, orders: [order] });
      const body = JSON.parse(String(init.body));
      if (body.action === "authorize") { order = { ...order, state: "AWAITING_NIM" }; return Response.json({ order, promptAllowed: true }); }
      return Response.json({ order });
    }));
    host.send.mockRejectedValue(new Error("Wallet response was lost. Do not pay again."));
    render(<Desk />);
    const pay = await screen.findByRole("button", { name: "Continue in Nimiq Pay" });
    expect((pay as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(pay); fireEvent.click(pay);
    await waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
    await screen.findByText(/Checking for your NIM payment/);
    expect(screen.queryByRole("button", { name: "Continue in Nimiq Pay" })).toBeNull();
  });
});
