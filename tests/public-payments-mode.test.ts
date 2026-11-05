/**
 * Public launch — THENCE_PAYMENTS_MODE=public through the real routes (live
 * ISOLATED test database; provider quotes mocked; nothing pays or swaps).
 *
 * A wallet that is NOT on the pilot allowlist creates and prepares payments
 * above the old 0.30 USDC pilot cap. Still enforced: the database kill
 * switch, the provider's live min/max, one unresolved payment per user and
 * mode off. Another user is not blocked by someone else's open payment (no
 * service-wide ceiling). Restores the test database's switch afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { pilotControls, transfers, users } from "@/db/schema";
import { getSatoraClient, setSatoraFetchersForTests } from "@/lib/satora";
import { LIVE, RUN, loginAs, postJson, type TestLogin } from "./helpers";
import { POST as createTransfer } from "../app/api/transfers/route";
import { POST as preparePost } from "../app/api/transfers/[id]/prepare/route";
import { GET as statusGet } from "../app/api/pilot/status/route";

const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const EVM_A = "0x0000000000000000000000000000000000000001";
const PILOT_OWNER = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000"; // allowlisted — our test wallets are NOT
const createdUserIds: string[] = [];
let priorSwitch: boolean | null = null;
let cc = 0;
const client = (tag: string) => ({ "x-forwarded-for": `pub-${RUN}-${tag}-${cc++}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function setSwitch(enabled: boolean): Promise<void> {
  await getDb()
    .insert(pilotControls)
    .values({ id: "pilot", enabled, updatedAt: new Date(), note: "public-payments-mode test (test database)" })
    .onConflictDoUpdate({ target: pilotControls.id, set: { enabled, updatedAt: new Date() } });
}

function create(login: TestLogin, amount: string, tag: string) {
  return createTransfer(
    postJson(
      "http://localhost/api/transfers",
      { routeId: "usdc-polygon", targetAmountAtomic: amount, idempotencyKey: `pub-${RUN}-${tag}`, direct: { asset: "USDC", network: "Polygon", address: EVM_A } },
      { cookie: login.cookie, ...client(tag) },
    ),
  );
}
const prepare = (login: TestLogin, id: string, tag: string) =>
  preparePost(postJson(`http://localhost/api/transfers/${id}/prepare`, { expectedQuoteRevision: 1 }, { cookie: login.cookie, ...client(tag) }), params(id));
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const status = async (login: TestLogin) =>
  ((await (await statusGet(new Request("http://localhost/api/pilot/status", { headers: { cookie: login.cookie } }))).json()) as { payments: string }).payments;
const rowsOf = async (userId: string) => getDb().select({ id: transfers.id }).from(transfers).where(eq(transfers.ownerUserId, userId));

describe.skipIf(!LIVE)("public payment mode (isolated test database)", () => {
  beforeAll(async () => {
    const row = await getDb().select({ enabled: pilotControls.enabled }).from(pilotControls).where(eq(pilotControls.id, "pilot")).limit(1);
    priorSwitch = row[0]?.enabled ?? null;
    vi.stubEnv("THENCE_ENABLED_ROUTES", "usdc-polygon");
    vi.stubEnv("THENCE_ROUTE_TOKENS_JSON", JSON.stringify({ "usdc-polygon": USDC_POLYGON }));
    setSatoraFetchersForTests({
      getTokens: async () => ({ evm_tokens: [{ token_id: USDC_POLYGON, symbol: "USDC", chain: "137", decimals: 6 }] }),
      getSwapPairs: async () => ({ pairs: [{ source: "Lightning", target: "137", min_sats: 356, max_sats: 20_000_000 }] }),
    });
    const sdk = await getSatoraClient();
    vi.spyOn(sdk, "getQuote").mockImplementation((async (req: { targetAmount?: bigint }) => {
      const target = req.targetAmount as bigint;
      // Fictional rate, test data only: 1 sat per 790 atomic USDC, 0.5% fee.
      const pre = target / 790n;
      const fee = pre / 200n;
      const net = pre + fee + 4n;
      return {
        net_target_amount: target.toString(),
        target_amount: target.toString(),
        net_source_amount: net.toString(),
        source_amount: pre.toString(),
        network_fee: 4,
        gasless_network_fee: 0,
        protocol_fee: Number(fee),
        protocol_fee_rate: 0.005,
        exchange_rate: "79000000",
        min_amount: 356,
        max_amount: 20_000_000,
      };
    }) as never);
  }, 60_000);

  beforeEach(() => {
    vi.stubEnv("THENCE_PAYMENTS_MODE", "public");
    // The pilot env is present and restrictive — public mode must ignore it.
    vi.stubEnv("THENCE_PILOT_ENABLED", "1");
    vi.stubEnv("THENCE_PILOT_OWNER_NIMIQ_ADDRESSES", PILOT_OWNER);
    vi.stubEnv("THENCE_PILOT_MAX_TARGET_ATOMIC", "300000");
    vi.stubEnv("THENCE_PILOT_MAX_SPEND_ATOMIC", "300000");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setSatoraFetchersForTests(null);
    if (!LIVE) return;
    if (priorSwitch === null) await getDb().delete(pilotControls).where(eq(pilotControls.id, "pilot"));
    else await setSwitch(priorSwitch);
    for (const id of createdUserIds) await getDb().delete(users).where(eq(users.id, id));
  }, 60_000);

  it("a non-allowlisted wallet creates and prepares a 25 USDC payment (old pilot cap was 0.30)", async () => {
    await setSwitch(true);
    const payer = await loginAs(client("payer"), (id) => createdUserIds.push(id));
    expect(await status(payer)).toBe("available");
    const res = await create(payer, "25000000", "big");
    expect(res.status, await res.clone().text()).toBe(201);
    const t = ((await res.json()) as { transfer: { id: string; targetAmountAtomic?: string } }).transfer;
    const prep = await prepare(payer, t.id, "big-prep");
    expect(prep.status, await prep.clone().text()).toBe(201);
    expect(((await prep.json()) as { attemptToken: string }).attemptToken.length).toBeGreaterThan(10);
  });

  it("one unresolved payment per user still applies; another user is not blocked (no service-wide cap)", async () => {
    await setSwitch(true);
    const a = await loginAs(client("a"), (id) => createdUserIds.push(id));
    const b = await loginAs(client("b"), (id) => createdUserIds.push(id));
    const first = ((await (await create(a, "5000000", "a1")).json()) as { transfer: { id: string } }).transfer;
    expect((await prepare(a, first.id, "a1-prep")).status).toBe(201);
    // Same user, second payment while the first is unresolved: refused, nothing created.
    const before = (await rowsOf(a.userId)).length;
    const second = await create(a, "5000000", "a2");
    expect(second.status).toBe(409);
    expect(await errorOf(second)).toBe("PAYMENT_EXPOSURE_UNCERTAIN");
    expect((await rowsOf(a.userId)).length).toBe(before);
    // A different user pays independently.
    const other = ((await (await create(b, "7000000", "b1")).json()) as { transfer: { id: string } }).transfer;
    expect((await prepare(b, other.id, "b1-prep")).status).toBe(201);
  });

  it("the provider's genuine limits still apply (above the provider maximum is refused)", async () => {
    await setSwitch(true);
    const payer = await loginAs(client("max"), (id) => createdUserIds.push(id));
    // 20,000 USDC at the fictional rate needs ~25.4M sats > provider max 20M.
    const res = await create(payer, "20000000000", "too-big");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("ABOVE_MAXIMUM");
    expect(await rowsOf(payer.userId)).toEqual([]);
  });

  it("emergency switch off: new payments refused (PILOT_DISABLED), status paused; nothing created", async () => {
    const payer = await loginAs(client("stop"), (id) => createdUserIds.push(id));
    await setSwitch(false);
    expect(await status(payer)).toBe("paused");
    const res = await create(payer, "1000000", "stopped");
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("PILOT_DISABLED");
    expect(await rowsOf(payer.userId)).toEqual([]);
    await setSwitch(true);
    expect(await status(payer)).toBe("available");
  });

  it("mode off or an invalid mode refuses everything (PAYMENTS_OFF) even with the switch on", async () => {
    await setSwitch(true);
    const payer = await loginAs(client("off"), (id) => createdUserIds.push(id));
    for (const mode of ["off", "enabled"]) {
      vi.stubEnv("THENCE_PAYMENTS_MODE", mode);
      expect(await status(payer)).toBe("paused");
      const res = await create(payer, "1000000", `off-${mode}`);
      expect(res.status, mode).toBe(403);
      expect(await errorOf(res)).toBe("PAYMENTS_OFF");
    }
    expect(await rowsOf(payer.userId)).toEqual([]);
  });

  it("pilot mode with the same env still refuses the non-allowlisted wallet", async () => {
    await setSwitch(true);
    vi.stubEnv("THENCE_PAYMENTS_MODE", "pilot");
    const payer = await loginAs(client("pilot"), (id) => createdUserIds.push(id));
    const res = await create(payer, "300000", "pilot-stranger");
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("PILOT_NOT_AUTHORIZED");
  });
});
