import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/auth";
import { GET, POST } from "../app/api/desk/route";
const mocks = vi.hoisted(() => ({ session: vi.fn(), quote: vi.fn(), list: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/auth", async original => ({ ...await original<typeof import("@/lib/auth")>(), requireSession: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitKeyFor: () => "test" }));
vi.mock("@/lib/desk/service", () => ({ listDeskOrders: mocks.list, quoteDesk: mocks.quote, checkDeskOrder: mocks.check, authorizeDesk: vi.fn(), reportDeskDeposit: vi.fn(), reportDeskRefund: vi.fn(), requestDeskRefund: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });
function request(body: unknown, origin = "http://localhost") { return new Request("http://localhost/api/desk", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }); }
describe("owner-scoped treasury API", () => {
  it("requires authentication for read and write", async () => {
    mocks.session.mockRejectedValue(new AuthError(401, "UNAUTHORIZED", "Sign in."));
    expect((await GET(new Request("http://localhost/api/desk"))).status).toBe(401);
    expect((await POST(request({ action: "check", id: crypto.randomUUID() }))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
  });
  it("rejects a cross-origin payout request before service access", async () => {
    expect((await POST(request({ action: "check", id: crypto.randomUUID() }, "https://evil.test"))).status).toBe(403);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("rejects client attempts to choose another owner or chain", async () => {
    mocks.session.mockResolvedValue({ userId: "owner", nimiqAddress: "NQ owner" });
    expect((await POST(request({ action: "quote", amount: "0.30", recipient: "0x1111111111111111111111111111111111111111", requestKey: "valid-key", ownerId: "another", chainId: 1 }))).status).toBe(400);
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it("passes verified session identity to the service", async () => {
    mocks.session.mockResolvedValue({ userId: "owner", nimiqAddress: "NQ owner" });
    const id = crypto.randomUUID(); mocks.check.mockResolvedValue({ id, state: "AWAITING_NIM" });
    expect((await POST(request({ action: "check", id }))).status).toBe(200);
    expect(mocks.check).toHaveBeenCalledWith("owner", "NQ owner", id);
  });
});
