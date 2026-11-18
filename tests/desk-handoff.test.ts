import { describe, expect, it, vi } from "vitest";
import { handoffDeskPayment } from "@/ui/lib/desk-handoff";

describe("treasury wallet handoff", () => {
  const order = { id: "payment", nimAddress: "NQ receiver", nimLuna: "123456", memo: "THENCE:D:payment" };
  it("never prompts again after a previous authorization, even without a returned hash", async () => {
    const send = vi.fn();
    await handoffDeskPayment({ authorize: async () => ({ order, promptAllowed: false }), send, saveHash: vi.fn(), report: vi.fn() });
    expect(send).not.toHaveBeenCalled();
  });
  it("pays the server-authorized terms once, saving the hash before reporting", async () => {
    const hash = "ab".repeat(32), calls: string[] = [];
    const send = vi.fn(async () => hash);
    await handoffDeskPayment({ authorize: async () => ({ order, promptAllowed: true }), send,
      saveHash: (_id, h) => { expect(h).toBe(hash); calls.push("saved"); },
      report: async () => { calls.push("reported"); } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ recipient: order.nimAddress, value: 123456, data: order.memo });
    expect(calls).toEqual(["saved", "reported"]);
  });
  it("never retries a wallet request whose result is unknown", async () => {
    const send = vi.fn(async () => { throw new Error("lost response"); });
    await expect(handoffDeskPayment({ authorize: async () => ({ order, promptAllowed: true }), send, saveHash: vi.fn(), report: vi.fn() })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
