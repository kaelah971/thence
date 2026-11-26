import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { getPool } from "@/lib/db";
import { findDeskDepositHashes, verifyDeskNimPayment, normalizeNimiqSourceHash } from "@/lib/nimiq-source";
import { assertDeskOwner, deskConfig } from "./config";
import { amountAtomic, deskCharge, DeskError } from "./policy";
import { deskRate } from "./price";
import { assertDeskSigner, deskBalances, deskEvm, deskPayoutEvidence, deskPayoutResult, signDeskPayout, validateSignedDeskPayout } from "./evm";
import { deskTransaction, loadDeskOrder, publicDeskOrder, transition, type DeskOrder, type DeskPayload } from "./store";
import { mirrorQuote, publishDeskProof } from "./ledger";
import { markSchedulesPaid } from "@/lib/schedules";
import { deskChainConfig, isDeskChain, type DeskChain } from "./chains";

export async function listDeskOrders(ownerId: string, ownerAddress: string) {
  const config = assertDeskOwner(ownerAddress);
  const result = await getPool().query<DeskOrder>("SELECT * FROM desk_orders WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 30", [ownerId]);
  return { enabled: config.enabled, collectionAddress: config.nimAddress, payoutAddress: config.polygonAddress, orders: result.rows.map(publicDeskOrder) };
}
const DESK_ROUTE: Record<DeskChain, string> = { polygon: "usdc-polygon", arbitrum: "usdc-arbitrum", base: "usdc-base" };

export async function quoteDesk(ownerId: string, ownerAddress: string, recipient: string, amount: string, requestKey: string, chain: DeskChain = "polygon") {
  const config = assertDeskOwner(ownerAddress, true);
  if (!isDeskChain(chain)) throw new DeskError("INVALID_NETWORK", "Choose Polygon or Arbitrum.", 400);
  assertDeskSigner(config.polygonAddress);
  if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient) || recipient.toLowerCase() === config.polygonAddress.toLowerCase() || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestKey)) throw new DeskError("INVALID_INPUT", "Check the recipient and request identifier.", 400);
  const atomic = amountAtomic(amount, 6);
  if (atomic < config.minAtomic || atomic > config.maxAtomic) throw new DeskError("AMOUNT_LIMIT", `Pilot payments must be between ${Number(config.minAtomic) / 1e6} USDC and the configured maximum.`, 400);
  const rate = await deskRate(), charge = deskCharge(atomic, rate.rateE18, config.feeBps);
  const quoted = await deskTransaction(async c => {
    const existing = await c.query<DeskOrder>("SELECT * FROM desk_orders WHERE owner_id=$1 AND request_key=$2", [ownerId, requestKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].payload.recipient.toLowerCase() !== recipient.toLowerCase() || existing.rows[0].amount_atomic !== atomic.toString()) throw new DeskError("REQUEST_CONFLICT", "This request identifier was already used for different payment terms.");
      return publicDeskOrder(existing.rows[0]);
    }
    const pending = await c.query("SELECT id FROM desk_orders WHERE owner_id=$1 AND state IN ('AWAITING_NIM','VERIFIED','PAYOUT_PREPARED','PAYOUT_SUBMITTED','REFUND_DUE') LIMIT 1", [ownerId]);
    if (pending.rowCount) throw new DeskError("PAYMENT_UNRESOLVED", "Resolve your existing treasury payment before starting another.");
    const expired = await c.query<DeskOrder>("SELECT * FROM desk_orders WHERE state='QUOTED' AND (expires_at<=now() OR owner_id=$1)", [ownerId]);
    for (const previous of expired.rows) await transition(c, previous, "EXPIRED", "QUOTE_REPLACED_OR_EXPIRED");
    // Read chain balances inside the shared lock so concurrent deliveries cannot stale the snapshot.
    const balances = await deskBalances(chain, config.polygonAddress);
    const reserved = await c.query<{ total: string }>("SELECT COALESCE(SUM(amount_atomic::numeric),0)::text AS total FROM desk_orders WHERE lower(payout_wallet)=lower($1) AND COALESCE(payload->>'chain','polygon')=$2 AND (state IN ('AWAITING_NIM','VERIFIED','PAYOUT_PREPARED','PAYOUT_SUBMITTED') OR (state='QUOTED' AND expires_at>now()))", [config.polygonAddress, chain]);
    if (balances.usdc - BigInt(reserved.rows[0]!.total) < atomic) {
      const spendable = balances.usdc - BigInt(reserved.rows[0]!.total);
      const liveUsdc = balances.usdcLive ?? balances.usdc;
      const live = liveUsdc - BigInt(reserved.rows[0]!.total);
      // Distinguish "not funded" from "funded but not final yet" — the second
      // resolves on its own and the user should be told to wait, not to top up.
      if (live >= atomic) {
        const waiting = (live - spendable);
        throw new DeskError("LIQUIDITY_FINALIZING", `${(Number(waiting) / 1e6).toFixed(2)} USDC arrived recently and is still finalizing; ${(Number(spendable) / 1e6).toFixed(2)} is spendable now. Try again in about 10 minutes.`, 409);
      }
      throw new DeskError("LIQUIDITY_LOW", "There is not enough unreserved USDC for this payment.");
    }
    const id = randomUUID(), expires = new Date(Date.now() + 60_000);
    const payload: DeskPayload = { ownerAddress, chain, recipient: getAddress(recipient), nimAddress: config.nimAddress, nimLuna: charge.totalLuna.toString(), baseLuna: charge.baseLuna.toString(), feeLuna: charge.feeLuna.toString(), memo: `THENCE:D:${id}`, rateE18: rate.rateE18.toString(), rateObservedAt: rate.observedAt, feeBps: config.feeBps };
    const inserted = await c.query<DeskOrder>("INSERT INTO desk_orders(id,owner_id,request_key,state,amount_atomic,payout_wallet,expires_at,payload) VALUES($1,$2,$3,'QUOTED',$4,$5,$6,$7) RETURNING *", [id, ownerId, requestKey, atomic.toString(), config.polygonAddress, expires, JSON.stringify(payload)]);
    await c.query("INSERT INTO desk_events(order_id,state,code) VALUES($1,'QUOTED','USDC_RESERVED')", [id]);
    // Activity and the global proof feed read `transfers`; mirror the order there.
    const transferId = await mirrorQuote(c, inserted.rows[0]!);
    const linked = await c.query<DeskOrder>("UPDATE desk_orders SET payload = $2 WHERE id = $1 RETURNING *", [id, JSON.stringify({ ...payload, transferId })]);
    return publicDeskOrder(linked.rows[0]!);
  });
  // A real payment for a due schedule spends its turn. Outside the transaction
  // so a schedule update can never roll back a quoted payment.
  void markSchedulesPaid(ownerId, DESK_ROUTE[chain], getAddress(recipient), atomic.toString()).catch(() => {});
  return quoted;
}
export async function authorizeDesk(ownerId: string, ownerAddress: string, id: string) {
  return deskTransaction(async c => {
    const order = await loadDeskOrder(c, id, ownerId);
    assertDeskOwner(ownerAddress, order.state === "QUOTED");
    if (order.state === "AWAITING_NIM") return { order: publicDeskOrder(order), promptAllowed: false };
    if (order.state !== "QUOTED" || order.expires_at.getTime() <= Date.now()) throw new DeskError("QUOTE_EXPIRED", "Get a fresh quote before paying.");
    assertDeskSigner(order.payout_wallet);
    order.payload.authorizedAt = Date.now();
    order.payload.fundingDeadline = Date.now() + 5 * 60_000;
    return { order: publicDeskOrder(await transition(c, order, "AWAITING_NIM", "WALLET_PROMPT_AUTHORIZED")), promptAllowed: true };
  });
}
export async function reportDeskDeposit(ownerId: string, ownerAddress: string, id: string, hash: string) {
  assertDeskOwner(ownerAddress);
  const normalized = normalizeNimiqSourceHash(hash);
  if (!normalized) throw new DeskError("INVALID_HASH", "Enter a valid Nimiq transaction hash.", 400);
  const order = await deskTransaction(async c => {
    const current = await loadDeskOrder(c, id, ownerId);
    if (current.state === "AWAITING_NIM" && current.payload.reportedHash !== normalized) {
      current.payload.reportedHash = normalized;
      return transition(c, current, current.state, "DEPOSIT_REPORTED_UNVERIFIED");
    }
    return current;
  });
  if (order.deposit_hash) {
    if (order.deposit_hash !== normalized) throw new DeskError("HASH_CONFLICT", "This payment already has a different verified deposit.");
    return publicDeskOrder(order);
  }
  if (!order.payload.authorizedAt) throw new DeskError("NOT_AUTHORIZED", "This quote was not authorized for payment.");
  const proof = await verifyDeskNimPayment({ txHash: normalized, ownerAddress: order.payload.ownerAddress, recipientAddress: order.payload.nimAddress, amountLuna: order.payload.nimLuna, memo: order.payload.memo, earliestMs: order.payload.authorizedAt - 30000, config: { url: deskConfig().nimRpc, network: "mainnet", minConfirmations: 10 } });
  if (!proof.ok) return deskTransaction(async c => {
    const current = await loadDeskOrder(c, id, ownerId);
    if (current.state !== "AWAITING_NIM" || current.payload.code === proof.code) return publicDeskOrder(current);
    return publicDeskOrder(await transition(c, current, current.state, proof.code));
  });
  return deskTransaction(async c => {
    const current = await loadDeskOrder(c, id, ownerId);
    if (current.deposit_hash && current.deposit_hash !== normalized) throw new DeskError("HASH_CONFLICT", "A different deposit was recorded.");
    if (current.deposit_hash) return publicDeskOrder(current);
    if (current.state !== "AWAITING_NIM") throw new DeskError("PAYMENT_STATE", "Payment requires operator recovery.");
    await c.query("UPDATE desk_orders SET deposit_hash=$2 WHERE id=$1", [id, normalized]);
    const late = proof.timestampMs > current.payload.fundingDeadline!;
    // Keep the source facts: the public proof is only publishable if the
    // delivery transition carries them alongside the Nimiq transaction hash.
    const withSource = { ...current, payload: { ...current.payload, source: proof.source } };
    await c.query("UPDATE desk_orders SET payload=$2 WHERE id=$1", [id, JSON.stringify(withSource.payload)]);
    return publicDeskOrder(await transition(c, withSource, late ? "REFUND_DUE" : "VERIFIED", late ? "LATE_DEPOSIT" : "NIM_MACRO_FINAL"));
  });
}
/** Preparing the signed transaction and recording it is one atomic DB operation; never broadcasts. */
async function preparePayout(id: string) {
  return deskTransaction(async c => {
    let order = await loadDeskOrder(c, id);
    if (order.state !== "VERIFIED") return order;
    const chain = deskChainConfig(order.payload.chain), client = deskEvm(order.payload.chain);
    if (await client.getChainId() !== chain.chainId) throw new DeskError("WRONG_CHAIN", `Invalid ${chain.label} network.`, 503);
    const networkNonce = await client.getTransactionCount({ address: order.payout_wallet, blockTag: "pending" });
    // Per chain: a nonce borrowed from another chain can never be mined here.
    const stored = await c.query<{ nonce: string | null }>(
      "SELECT MAX(payout_nonce)::text AS nonce FROM desk_orders WHERE lower(payout_wallet)=lower($1) AND COALESCE(payload->>'chain','polygon')=$2",
      [order.payout_wallet, order.payload.chain],
    );
    const nonce = Math.max(networkNonce, stored.rows[0]?.nonce === null ? 0 : Number(stored.rows[0]!.nonce) + 1);
    const signed = await signDeskPayout(order, nonce);
    await c.query("UPDATE desk_orders SET payout_hash=$2,payout_nonce=$3,signed_payout=$4 WHERE id=$1", [id, signed.hash, nonce, signed.raw]);
    order = await transition(c, order, "PAYOUT_PREPARED", "SIGNED_BEFORE_BROADCAST");
    return order;
  });
}
export async function processDeskPayout(id: string) {
  let order = await preparePayout(id);
  if (!["PAYOUT_PREPARED", "PAYOUT_SUBMITTED"].includes(order.state)) return publicDeskOrder(order);
  await validateSignedDeskPayout(order, order.signed_payout!);
  const evidence = await deskPayoutEvidence(order);
  const result = evidence.outcome;
  if (result === "pending") {
    // Identical bytes on every retry: an RPC timeout cannot create another payment.
    const chain = deskChainConfig(order.payload.chain), client = deskEvm(order.payload.chain);
    if (await client.getChainId() !== chain.chainId) throw new DeskError("WRONG_CHAIN", `Invalid ${chain.label} network.`, 503);
    try { await client.sendRawTransaction({ serializedTransaction: order.signed_payout! }); } catch { /* Broadcast outcome unknown; keep reservation and saved bytes. */ }
    order = await deskTransaction(async c => {
      const current = await loadDeskOrder(c, id);
      return current.state === "PAYOUT_PREPARED" ? transition(c, current, "PAYOUT_SUBMITTED", "BROADCAST_ATTEMPTED") : current;
    });
  } else if (result !== "mismatch") {
    order = await deskTransaction(async c => {
      const current = await loadDeskOrder(c, id);
      if (!["PAYOUT_PREPARED", "PAYOUT_SUBMITTED"].includes(current.state)) return current;
      const chain = deskChainConfig(current.payload.chain);
      if (result === "delivered" && evidence.blockNumber !== undefined && evidence.blockHash) {
        const marker = await publishDeskProof(c, current, { blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, logIndexes: evidence.logIndexes ?? [] });
        return transition(c, current, "DELIVERED", `${chain.label.toUpperCase()}_TRANSFER_FINAL`, marker);
      }
      return transition(c, current, "REFUND_DUE", "PAYOUT_REVERTED_FINAL");
    });
  }
  return publicDeskOrder(order);
}
export async function checkDeskOrder(ownerId: string, ownerAddress: string, id: string) {
  assertDeskOwner(ownerAddress);
  let order = await deskTransaction(c => loadDeskOrder(c, id, ownerId));
  if (order.state === "AWAITING_NIM" && order.payload.reportedHash) {
    await reportDeskDeposit(ownerId, ownerAddress, id, order.payload.reportedHash);
    order = await deskTransaction(c => loadDeskOrder(c, id, ownerId));
  }
  if (order.state === "AWAITING_NIM") {
    // A reported hash is only a candidate. Failed proof must not suppress discovery.
    const candidates = await findDeskDepositHashes(deskConfig().nimRpc, order.payload.nimAddress, order.payload.memo);
    if (candidates.length > 1) {
      return deskTransaction(async c => {
        const current = await loadDeskOrder(c, id, ownerId);
        return publicDeskOrder(current.state === "AWAITING_NIM" && current.payload.code !== "MULTIPLE_DEPOSITS" ? await transition(c, current, current.state, "MULTIPLE_DEPOSITS") : current);
      });
    }
    if (candidates[0] && candidates[0] !== order.payload.reportedHash) {
      await reportDeskDeposit(ownerId, ownerAddress, id, candidates[0]);
      order = await deskTransaction(c => loadDeskOrder(c, id, ownerId));
    }
  }
  return order.state === "VERIFIED" || order.signed_payout ? processDeskPayout(id) : publicDeskOrder(order);
}

/** Records an operator-sent full NIM return only after chain finality. Never sends a refund. */
export async function reportDeskRefund(ownerId: string, ownerAddress: string, id: string, hash: string) {
  assertDeskOwner(ownerAddress);
  const order = await deskTransaction(c => loadDeskOrder(c, id, ownerId));
  if (order.state !== "REFUND_DUE") throw new DeskError("REFUND_NOT_DUE", "This payment is not awaiting a refund.");
  if (order.signed_payout && await deskPayoutResult(order) !== "reverted") throw new DeskError("PAYOUT_UNRESOLVED", "The saved payout must be proved reverted before recording a refund.");
  const proof = await verifyDeskNimPayment({ txHash: hash, ownerAddress: order.payload.nimAddress, recipientAddress: order.payload.ownerAddress, amountLuna: order.payload.nimLuna, memo: `THENCE:R:${id}`, earliestMs: order.payload.authorizedAt!, config: { url: deskConfig().nimRpc, network: "mainnet", minConfirmations: 10 } });
  if (!proof.ok) throw new DeskError(proof.code, "The full NIM return is not yet verified.");
  return deskTransaction(async c => {
    const current = await loadDeskOrder(c, id, ownerId);
    if (current.state !== "REFUND_DUE") throw new DeskError("REFUND_NOT_DUE", "Payment state changed.");
    current.payload.refundHash = normalizeNimiqSourceHash(hash)!;
    return publicDeskOrder(await transition(c, current, "REFUNDED", "NIM_RETURN_MACRO_FINAL"));
  });
}

/** A verified deposit may be returned only before any payout authorization is signed. */
export async function requestDeskRefund(ownerId: string, ownerAddress: string, id: string) {
  assertDeskOwner(ownerAddress);
  return deskTransaction(async c => {
    const order = await loadDeskOrder(c, id, ownerId);
    if (order.state === "REFUND_DUE") return publicDeskOrder(order);
    if (order.state !== "VERIFIED" || order.signed_payout || order.payout_hash) throw new DeskError("PAYOUT_UNRESOLVED", "A NIM return cannot be queued while a payout may execute.");
    return publicDeskOrder(await transition(c, order, "REFUND_DUE", "OWNER_REQUESTED_NIM_RETURN"));
  });
}
