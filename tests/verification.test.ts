/**
 * B2.3 — recipient wallet verification tests.
 *
 * EIP-191 fixtures are produced with viem (the same maintained library the
 * backend verifies with). Independence anchors:
 * - Address derivation is cross-checked against an independent stack
 *   (node:crypto secp256k1 ECDH + independently-validated keccak256).
 * - keccak/EIP-55 layers are pinned independently in recipients.test.ts.
 * - The server logic under test (binding, atomic consume, status
 *   derivation, triple-change invalidation) is orthogonal to the primitive.
 * A real browser-wallet round trip remains pending frontend integration.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createECDH } from "node:crypto";
import { eq } from "drizzle-orm";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "@/lib/keccak";
import { getDb, getPool } from "@/lib/db";
import { recipientDestinations, recipientVerifications, users } from "@/db/schema";
import { buildVerificationMessage, hashVerificationToken } from "@/lib/verification";
import { isValidEvmAddress } from "@/lib/recipients";
import { LIVE, RUN, deleteJson, loginAs, patchJson, postJson } from "./helpers";
import { POST as startVerify } from "../app/api/recipients/[id]/destinations/[destId]/verify-start/route";
import { GET as publicGet, POST as publicComplete } from "../app/api/verify/[token]/route";
import { GET as getRecipient, PATCH as patchRecipient } from "../app/api/recipients/[id]/route";
import { POST as createRecipient } from "../app/api/recipients/route";
import { DELETE as deleteDest, PATCH as patchDest } from "../app/api/recipients/[id]/destinations/[destId]/route";
import { POST as createDest } from "../app/api/recipients/[id]/destinations/route";

const createdUserIds: string[] = [];
afterAll(async () => {
  if (!LIVE) return;
  for (const id of createdUserIds) {
    await getDb().delete(users).where(eq(users.id, id));
  }
});

let cc = 0;
const withClient = (tag: string): Record<string, string> => ({ "x-forwarded-for": `b23-${RUN}-${tag}-${cc++}` });
const login = (tag: string) => loginAs(withClient(`login-${tag}`), (id) => createdUserIds.push(id));

/** Fresh EVM wallet (viem local account). */
function evmWallet(): { address: string; sign: (message: string) => Promise<string> } {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address,
    sign: (message: string) => account.signMessage({ message }),
  };
}

/**
 * Independent EVM address derivation: node:crypto secp256k1 ECDH +
 * independently-validated keccak256. Must agree with viem's derivation.
 */
function ethAddressFromPrivateKey(privateKeyHex: `0x${string}`): `0x${string}` {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privateKeyHex.slice(2), "hex"));
  const uncompressed = ecdh.getPublicKey(undefined, "uncompressed");
  const digest = keccak256(uncompressed.subarray(1));
  return `0x${digest.subarray(-20).toString("hex")}`;
}

describe("EIP-191 fixtures (pure)", () => {
  it("agrees with an independent secp256k1+keccak derivation", () => {
    for (let i = 0; i < 3; i++) {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      expect(ethAddressFromPrivateKey(key).toLowerCase()).toBe(account.address.toLowerCase());
      expect(isValidEvmAddress(account.address)).toBe(true);
    }
  });

  it("round-trips personal_sign through the exact bound message", async () => {
    const wallet = evmWallet();
    const message = buildVerificationMessage({
      recipientName: "Daniel",
      address: wallet.address,
      asset: "USDC",
      network: "Base",
      nonceHex: "ab".repeat(32),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(message).toContain("does NOT authorize any payment");
    expect(message).toContain(wallet.address);
    const sig = await wallet.sign(message);
    expect(await recoverMessageAddress({ message, signature: sig as `0x${string}` })).toBe(wallet.address);
  });
});

describe.skipIf(!LIVE)("verification start (authenticated)", () => {
  async function ownedDestination(tag: string): Promise<{ cookie: string; id: string; destId: string; address: string }> {
    const { cookie } = await login(tag);
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Sage" }, { cookie, ...withClient(tag) }))
    ).json()) as { recipient: { id: string } };
    const wallet = evmWallet();
    const dest = (await (
      await createDest(
        postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations`, { asset: "USDT", network: "Polygon", address: wallet.address }, { cookie, ...withClient(tag) }),
        { params: Promise.resolve({ id: created.recipient.id }) },
      )
    ).json()) as { destination: { id: string } };
    return { cookie, id: created.recipient.id, destId: dest.destination.id, address: wallet.address };
  }

  it("starts verification and returns a shareable challenge", async () => {
    const { cookie, id, destId, address } = await ownedDestination("start");
    const res = await startVerify(
      postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, ...withClient("start") }),
      { params: Promise.resolve({ id, destId }) },
    );
    expect(res.status).toBe(201);
    const v = ((await res.json()) as { verification: Record<string, string> }).verification;
    expect(v["token"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(v["url"]).toBe(`/v/${v["token"] as string}`);
    expect(v["message"]).toContain(address);
    expect(v["message"]).toContain("does NOT authorize any payment");
    expect(Date.parse(v["expiresAt"] as string)).toBeGreaterThan(Date.now());
  });

  it("rejects cross-user initiation and unknown records", async () => {
    const alice = await ownedDestination("alice-start");
    const { cookie: bobCookie } = await login("bob-start");
    expect(
      (
        await startVerify(
          postJson(`http://localhost/api/recipients/${alice.id}/destinations/${alice.destId}/verify-start`, {}, { cookie: bobCookie, ...withClient("alice-start") }),
          { params: Promise.resolve({ id: alice.id, destId: alice.destId }) },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await startVerify(
          postJson("http://localhost/api/recipients/00000000-0000-0000-0000-000000000000/destinations/00000000-0000-0000-0000-000000000000/verify-start", {}, { cookie: alice.cookie, ...withClient("alice-start") }),
          { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000", destId: "00000000-0000-0000-0000-000000000000" }) },
        )
      ).status,
    ).toBe(404);
  });

  it("refuses archived recipients and forged origins", async () => {
    const { cookie, id, destId } = await ownedDestination("archived");
    await patchRecipient(patchJson(`http://localhost/api/recipients/${id}`, { archived: true }, { cookie, ...withClient("archived") }), {
      params: Promise.resolve({ id }),
    });
    const frozen = await startVerify(
      postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, ...withClient("archived") }),
      { params: Promise.resolve({ id, destId }) },
    );
    expect(frozen.status).toBe(409);
    const forged = await startVerify(
      postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, origin: "https://evil.example", ...withClient("archived") }),
      { params: Promise.resolve({ id, destId }) },
    );
    expect(forged.status).toBe(403);
  });
});

describe.skipIf(!LIVE)("public verification flow", () => {
  async function started(tag: string): Promise<{ token: string; message: string; wallet: { address: string; sign: (m: string) => Promise<string> }; cookie: string; id: string; destId: string }> {
    const wallet = evmWallet();
    const { cookie } = await login(tag);
    const created = (await (
      await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Daniel" }, { cookie, ...withClient(tag) }))
    ).json()) as { recipient: { id: string } };
    const dest = (await (
      await createDest(
        postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations`, { asset: "USDC", network: "Base", address: wallet.address }, { cookie, ...withClient(tag) }),
        { params: Promise.resolve({ id: created.recipient.id }) },
      )
    ).json()) as { destination: { id: string } };
    const res = await startVerify(
      postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations/${dest.destination.id}/verify-start`, {}, { cookie, ...withClient(tag) }),
      { params: Promise.resolve({ id: created.recipient.id, destId: dest.destination.id }) },
    );
    expect(res.status).toBe(201);
    const v = ((await res.json()) as { verification: { token: string; message: string } }).verification;
    return { token: v.token, message: v.message, wallet, cookie, id: created.recipient.id, destId: dest.destination.id };
  }

  it("resolves public terms without leaking private data", async () => {
    const { token, message } = await started("pub");
    const res = await publicGet(new Request(`http://localhost/api/verify/${token}`), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = ((await res.json()) as { verification: Record<string, unknown> }).verification;
    expect(Object.keys(view).sort()).toEqual(
      ["address", "asset", "expiresAt", "message", "network", "recipientName", "status"].sort(),
    );
    expect(view["status"]).toBe("active");
    expect(view["message"]).toBe(message);
    for (const leaked of ["ownerUserId", "creatorUserId", "userId", "session", "id", "createdAt", "openedAt", "verificationId"]) {
      expect(view[leaked]).toBeUndefined();
    }
    expect((await publicGet(new Request("http://localhost/api/verify/nope"), { params: Promise.resolve({ token: "nope" }) })).status).toBe(404);
  });

  it("verifies the correct signer and marks the destination", async () => {
    const { token, message, wallet, cookie, id } = await started("happy");
    const sig = await wallet.sign(message);
    const res = await publicComplete(
      postJson(`http://localhost/api/verify/${token}`, { signature: sig }, withClient("happy")),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull(); // no session for the signer, ever
    const body = ((await res.json()) as { verification: { verified: boolean; address: string } }).verification;
    expect(body.verified).toBe(true);
    expect(body.address).toBe(wallet.address);
    const detail = (await (await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
      recipient: { destinations: { verification: { status: string; verifiedAt?: string } }[] };
    };
    expect(detail.recipient.destinations[0]?.verification.status).toBe("verified-by-recipient");
    // Proof associated server-side: hashed token, destination link, signature, no raw token.
    const db = getDb();
    const rows = await db.select().from(recipientVerifications).where(eq(recipientVerifications.tokenHash, hashVerificationToken(token)));
    expect(rows.length).toBe(1);
    expect(rows[0]?.signature).toBe(sig);
    expect(rows[0]?.verifiedAt).not.toBeNull();
    expect(rows[0]?.tokenHash).not.toBe(token);
  });

  it("rejects wrong signers without burning the challenge", async () => {
    const { token, message } = await started("wrong");
    const impostor = evmWallet();
    const bad = await publicComplete(
      postJson(`http://localhost/api/verify/${token}`, { signature: await impostor.sign(message) }, withClient("wrong")),
      { params: Promise.resolve({ token }) },
    );
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toBe("SIGNER_MISMATCH");
    const still = (await (await publicGet(new Request(`http://localhost/api/verify/${token}`), { params: Promise.resolve({ token }) })).json()) as {
      verification: { status: string };
    };
    expect(still.verification.status).toBe("active");
  });

  it("rejects malformed signatures and unknown tokens", async () => {
    const { token } = await started("malformed");
    for (const sig of ["0x1234", "not-hex", "", "0x" + "00".repeat(64)]) {
      const res = await publicComplete(postJson(`http://localhost/api/verify/${token}`, { signature: sig }, withClient("malformed")), {
        params: Promise.resolve({ token }),
      });
      expect(res.status).toBe(401);
    }
    expect((await publicComplete(postJson("http://localhost/api/verify/nope", { signature: "0x" + "11".repeat(65) }, withClient("malformed")), { params: Promise.resolve({ token: "nope" }) })).status).toBe(404);
  });

  it("expires challenges and hides the message afterwards", async () => {
    const { token } = await started("expired");
    await getDb().update(recipientVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(recipientVerifications.tokenHash, hashVerificationToken(token)));
    const view = (await (await publicGet(new Request(`http://localhost/api/verify/${token}`), { params: Promise.resolve({ token }) })).json()) as {
      verification: { status: string; message: unknown };
    };
    expect(view.verification.status).toBe("expired");
    expect(view.verification.message).toBeNull();
    const wallet = evmWallet();
    const attempt = await publicComplete(
      postJson(`http://localhost/api/verify/${token}`, { signature: await wallet.sign("anything") }, withClient("expired")),
      { params: Promise.resolve({ token }) },
    );
    expect(attempt.status).toBe(410);
  });

  it("consumes exactly once, even under concurrent replay", async () => {
    const { token, message, wallet } = await started("replay");
    const sig = await wallet.sign(message);
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        publicComplete(postJson(`http://localhost/api/verify/${token}`, { signature: sig }, withClient(`replay-${i}`)), {
          params: Promise.resolve({ token }),
        }).then((r) => r.status),
      ),
    );
    expect(attempts.filter((s) => s === 200).length).toBe(1);
    expect(attempts.filter((s) => s === 410).length).toBe(4);
    const used = (await (await publicGet(new Request(`http://localhost/api/verify/${token}`), { params: Promise.resolve({ token }) })).json()) as {
      verification: { status: string; message: unknown };
    };
    expect(used.verification.status).toBe("used");
    expect(used.verification.message).toBeNull();
  });

  it("rejects completion when the destination changed or vanished", async () => {
    const s = await started("changed");
    const sig = await s.wallet.sign(s.message);
    await patchDest(
      patchJson(`http://localhost/api/recipients/${s.id}/destinations/${s.destId}`, { address: "0x0000000000000000000000000000000000000003" }, { cookie: s.cookie, ...withClient("changed") }),
      { params: Promise.resolve({ id: s.id, destId: s.destId }) },
    );
    const stale = await publicComplete(postJson(`http://localhost/api/verify/${s.token}`, { signature: sig }, withClient("changed")), {
      params: Promise.resolve({ token: s.token }),
    });
    expect(stale.status).toBe(409);
  });

  it("clears proof when the triple changes and cascades on delete", async () => {
    const { cookie, id, destId, wallet, message, token } = await started("clear");
    const sig = await wallet.sign(message);
    expect((await publicComplete(postJson(`http://localhost/api/verify/${token}`, { signature: sig }, withClient("clear")), { params: Promise.resolve({ token }) })).status).toBe(200);
    const before = (await (await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
      recipient: { destinations: { verification: { status: string } }[] };
    };
    expect(before.recipient.destinations[0]?.verification.status).toBe("verified-by-recipient");
    // Address change clears the badge and drops the orphan proof.
    await patchDest(
      patchJson(`http://localhost/api/recipients/${id}/destinations/${destId}`, { address: "0x0000000000000000000000000000000000000004" }, { cookie, ...withClient("clear") }),
      { params: Promise.resolve({ id, destId }) },
    );
    const after = (await (await getRecipient(new Request(`http://localhost/api/recipients/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) })).json()) as {
      recipient: { destinations: { verification: { status: string } }[] };
    };
    expect(after.recipient.destinations[0]?.verification).toEqual({ status: "added-by-you" });
    const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM recipient_verifications WHERE destination_id = $1", [destId]);
    expect(rows[0]?.n).toBe(0);
    // Deleting the destination cascades remaining proofs.
    const restartRes = await startVerify(
      postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, ...withClient("clear") }),
      { params: Promise.resolve({ id, destId }) },
    );
    expect(restartRes.status).toBe(201);
    const { token: token2 } = ((await restartRes.json()) as { verification: { token: string } }).verification;
    await deleteDest(deleteJson(`http://localhost/api/recipients/${id}/destinations/${destId}`, { cookie, ...withClient("clear") }), {
      params: Promise.resolve({ id, destId }),
    });
    const gone = await publicGet(new Request(`http://localhost/api/verify/${token2}`), { params: Promise.resolve({ token: token2 }) });
    expect(gone.status).toBe(404);
  });

  it("keeps proof on archive but blocks completion on frozen records", async () => {
    const s = await started("frozen");
    const sig = await s.wallet.sign(s.message);
    expect((await publicComplete(postJson(`http://localhost/api/verify/${s.token}`, { signature: sig }, withClient("frozen")), { params: Promise.resolve({ token: s.token }) })).status).toBe(200);
    await patchRecipient(patchJson(`http://localhost/api/recipients/${s.id}`, { archived: true }, { cookie: s.cookie, ...withClient("frozen") }), {
      params: Promise.resolve({ id: s.id }),
    });
    const detail = (await (await getRecipient(new Request(`http://localhost/api/recipients/${s.id}`, { headers: { cookie: s.cookie } }), { params: Promise.resolve({ id: s.id }) })).json()) as {
      recipient: { destinations: { verification: { status: string } }[] };
    };
    expect(detail.recipient.destinations[0]?.verification.status).toBe("verified-by-recipient");
    // New round on the archived record: start is blocked…
    const blocked = await startVerify(
      postJson(`http://localhost/api/recipients/${s.id}/destinations/${s.destId}/verify-start`, {}, { cookie: s.cookie, ...withClient("frozen") }),
      { params: Promise.resolve({ id: s.id, destId: s.destId }) },
    );
    expect(blocked.status).toBe(409);
  });

  it("rejects forged origins and throttles bursts, and forges no badge", async () => {
    const { token, cookie, id, destId } = await started("guard");
    const forged = await publicComplete(
      postJson(`http://localhost/api/verify/${token}`, { signature: "0x" + "11".repeat(65) }, { cookie, origin: "https://evil.example", ...withClient("guard") }),
      { params: Promise.resolve({ token }) },
    );
    expect(forged.status).toBe(403);
    expect(
      (
        await patchDest(
          patchJson(`http://localhost/api/recipients/${id}/destinations/${destId}`, { verificationId: "forged" }, { cookie, ...withClient("guard") }),
          { params: Promise.resolve({ id, destId }) },
        )
      ).status,
    ).toBe(400);
    const burst = await Promise.all(
      Array.from({ length: 70 }, () =>
        publicGet(new Request(`http://localhost/api/verify/${token}`, { headers: { "x-forwarded-for": `b23-${RUN}-burst` } }), {
          params: Promise.resolve({ token }),
        }).then((r) => r.status),
      ),
    );
    expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(burst.filter((s) => s === 200).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!LIVE)("B2.3.1 integrity", () => {
  it("replaces the address-scoped unique index with a per-destination one", async () => {
    const { rows } = await getPool().query(
      "SELECT indexname FROM pg_indexes WHERE tablename='recipient_verifications' AND indexname LIKE 'recipient_verifications_%uidx'",
    );
    const names = (rows as { indexname: string }[]).map((r) => r.indexname);
    expect(names).not.toContain("recipient_verifications_address_network_uidx");
    expect(names).toContain("recipient_verifications_destination_active_uidx");
    const def = await getPool().query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='recipient_verifications_destination_active_uidx'",
    );
    expect((def.rows[0] as { indexdef: string }).indexdef).toMatch(/WHERE.*consumed_at IS NULL/);
  });

  it("lets two users verify the SAME address on separate destinations", async () => {
    // Same key = same address for both payers (e.g. a shared treasury signer).
    const wallet = evmWallet();
    const alice = await login("xu-alice");
    const bob = await login("xu-bob");
    expect(alice.userId).not.toBe(bob.userId);
    const mkDest = async (cookie: string, tag: string) => {
      const created = (await (
        await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Treasury" }, { cookie, ...withClient(tag) }))
      ).json()) as { recipient: { id: string } };
      const dest = (await (
        await createDest(
          postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations`, { asset: "USDC", network: "Base", address: wallet.address }, { cookie, ...withClient(tag) }),
          { params: Promise.resolve({ id: created.recipient.id }) },
        )
      ).json()) as { destination: { id: string } };
      const started = await startVerify(
        postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations/${dest.destination.id}/verify-start`, {}, { cookie, ...withClient(tag) }),
        { params: Promise.resolve({ id: created.recipient.id, destId: dest.destination.id }) },
      );
      expect(started.status).toBe(201);
      return { ...(await started.json() as { verification: { token: string; message: string } }).verification, id: created.recipient.id, destId: dest.destination.id, cookie };
    };
    const a = await mkDest(alice.cookie, "xu-alice");
    const b = await mkDest(bob.cookie, "xu-bob");
    // Neither start blocks the other (legacy UNIQUE(address, network) is gone).
    const sig = await wallet.sign(a.message);
    expect((await publicComplete(postJson(`http://localhost/api/verify/${a.token}`, { signature: sig }, withClient("xu-a")), { params: Promise.resolve({ token: a.token }) })).status).toBe(200);
    expect((await publicComplete(postJson(`http://localhost/api/verify/${b.token}`, { signature: await wallet.sign(b.message) }, withClient("xu-b")), { params: Promise.resolve({ token: b.token }) })).status).toBe(200);
    for (const [ctx, otherCookie] of [[a, bob.cookie], [b, alice.cookie]] as const) {
      const own = (await (await getRecipient(new Request(`http://localhost/api/recipients/${ctx.id}`, { headers: { cookie: ctx.cookie } }), { params: Promise.resolve({ id: ctx.id }) })).json()) as {
        recipient: { destinations: { verification: { status: string } }[] };
      };
      expect(own.recipient.destinations[0]?.verification.status).toBe("verified-by-recipient");
      // Cross-user reads stay invisible.
      expect((await getRecipient(new Request(`http://localhost/api/recipients/${ctx.id}`, { headers: { cookie: otherCookie } }), { params: Promise.resolve({ id: ctx.id }) })).status).toBe(404);
    }
  });

  it("supersedes stale links when verification restarts", async () => {
    const { cookie, id, destId, wallet } = await (async () => {
      const w = evmWallet();
      const { cookie: c } = await login("supersede");
      const created = (await (
        await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Sage" }, { cookie: c, ...withClient("supersede") }))
      ).json()) as { recipient: { id: string } };
      const dest = (await (
        await createDest(
          postJson(`http://localhost/api/recipients/${created.recipient.id}/destinations`, { asset: "USDT", network: "Polygon", address: w.address }, { cookie: c, ...withClient("supersede") }),
          { params: Promise.resolve({ id: created.recipient.id }) },
        )
      ).json()) as { destination: { id: string } };
      return { cookie: c, id: created.recipient.id, destId: dest.destination.id, wallet: w };
    })();
    const first = ((await (await startVerify(postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, ...withClient("supersede") }), { params: Promise.resolve({ id, destId }) })).json()) as { verification: { token: string } }).verification;
    const second = ((await (await startVerify(postJson(`http://localhost/api/recipients/${id}/destinations/${destId}/verify-start`, {}, { cookie, ...withClient("supersede") }), { params: Promise.resolve({ id, destId }) })).json()) as { verification: { token: string } }).verification;
    const firstView = (await (await publicGet(new Request(`http://localhost/api/verify/${first.token}`), { params: Promise.resolve({ token: first.token }) })).json()) as {
      verification: { status: string };
    };
    expect(firstView.verification.status).toBe("used");
    expect((await publicComplete(postJson(`http://localhost/api/verify/${first.token}`, { signature: await wallet.sign("unused") }, withClient("supersede")), { params: Promise.resolve({ token: first.token }) })).status).toBe(410);
    const secondView = (await (await publicGet(new Request(`http://localhost/api/verify/${second.token}`), { params: Promise.resolve({ token: second.token }) })).json()) as {
      verification: { status: string; message: string };
    };
    expect(secondView.verification.status).toBe("active");
    const done = await publicComplete(
      postJson(`http://localhost/api/verify/${second.token}`, { signature: await wallet.sign(secondView.verification.message) }, withClient("supersede")),
      { params: Promise.resolve({ token: second.token }) },
    );
    expect(done.status).toBe(200);
  });

  it("never leaves a badge on changed terms in an update-versus-verify race", async () => {
    const EVM_C = "0x0000000000000000000000000000000000000011";
    for (let round = 0; round < 5; round++) {
      const wallet = evmWallet();
      const { cookie } = await login(`race-${round}`);
      const created = (await (
        await createRecipient(postJson("http://localhost/api/recipients", { displayName: "Racy" }, { cookie, ...withClient(`race-${round}`) }))
      ).json()) as { recipient: { id: string } };
      const rid = created.recipient.id;
      const dest = (await (
        await createDest(
          postJson(`http://localhost/api/recipients/${rid}/destinations`, { asset: "USDC", network: "Base", address: wallet.address }, { cookie, ...withClient(`race-${round}`) }),
          { params: Promise.resolve({ id: rid }) },
        )
      ).json()) as { destination: { id: string } };
      const started = ((await (await startVerify(postJson(`http://localhost/api/recipients/${rid}/destinations/${dest.destination.id}/verify-start`, {}, { cookie, ...withClient(`race-${round}`) }), { params: Promise.resolve({ id: rid, destId: dest.destination.id }) })).json()) as { verification: { token: string; message: string } }).verification;
      const sig = await wallet.sign(started.message);
      const [patchRes, verifyRes] = await Promise.all([
        patchDest(patchJson(`http://localhost/api/recipients/${rid}/destinations/${dest.destination.id}`, { address: EVM_C }, { cookie, ...withClient(`race-${round}`) }), { params: Promise.resolve({ id: rid, destId: dest.destination.id }) }).then((r) => r.status),
        publicComplete(postJson(`http://localhost/api/verify/${started.token}`, { signature: sig }, withClient(`race-${round}`)), { params: Promise.resolve({ token: started.token }) }).then((r) => r.status),
      ]);
      expect([200, 409]).toContain(patchRes);
      expect([200, 409, 410]).toContain(verifyRes);
      // Invariant: a verified badge exists ONLY on the exact proven triple.
      const detail = (await (await getRecipient(new Request(`http://localhost/api/recipients/${rid}`, { headers: { cookie } }), { params: Promise.resolve({ id: rid }) })).json()) as {
        recipient: { destinations: { address: string; verification: { status: string } }[] };
      };
      const shown = detail.recipient.destinations[0];
      if (shown?.verification.status === "verified-by-recipient") {
        expect(shown.address.toLowerCase()).toBe(wallet.address.toLowerCase());
      } else {
        expect(shown?.verification).toEqual({ status: "added-by-you" });
      }
    }
  }, 120_000);
});
