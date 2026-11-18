import { describe, expect, it, vi } from "vitest";
import { runDeskBatch } from "@/lib/desk/worker";
const state = vi.hoisted(() => ({ rows: Array.from({ length: 12 }, (_, n) => ({ id: String(n), state: "AWAITING_NIM", owner_id: "owner", payload: { nimAddress: "NQ", memo: `memo-${n}`, ownerAddress: "NQ" }, checked: 0 })), checks: new Set<string>() }));
vi.mock("@/lib/desk/config", () => ({ deskConfig: () => ({ nimRpc: "https://nim.test" }) }));
vi.mock("@/lib/nimiq-source", () => ({ findDeskDepositHashes: async () => [] }));
vi.mock("@/lib/desk/service", () => ({ reportDeskDeposit: vi.fn(), checkDeskOrder: async (_owner: string, _address: string, id: string) => { state.checks.add(id); return { state: "AWAITING_NIM" }; } }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: async (sql: string, params: string[]) => {
  if (sql.startsWith("SELECT")) return { rows: [...state.rows].sort((a, b) => a.checked - b.checked).slice(0, 10) };
  if (sql.startsWith("UPDATE")) { const row = state.rows.find(r => r.id === params[0]); if (row) row.checked++; }
  return { rows: [] };
} }) }));
describe("treasury worker fairness", () => {
  it("does not let ten unpaid orders starve later funded payments", async () => {
    await runDeskBatch(); await runDeskBatch();
    expect(state.checks.size).toBe(12);
  });
});
