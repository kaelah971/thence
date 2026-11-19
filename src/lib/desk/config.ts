import { getAddress, isAddress } from "viem";
import { normalizeNimiqAddress } from "@/lib/nimiq";
import { DeskError } from "./policy";

export function deskConfig() {
  const nim = process.env["THENCE_DESK_NIM_ADDRESS"] ?? "";
  const polygon = process.env["THENCE_DESK_POLYGON_ADDRESS"] ?? "";
  const rpc = process.env["THENCE_DESK_POLYGON_RPC"] ?? "";
  const nimRpc = process.env["THENCE_NIMIQ_PROOF_RPC_URL"] ?? "";
  // Open mode removes the invite list; every signed-in wallet may use the desk.
  // The owners list stays parsed so a later closed-mode switch takes effect
  // without rewriting the env file.
  const open = process.env["THENCE_DESK_OPEN"] === "true";
  const owners = (process.env["THENCE_DESK_OWNER_ADDRESSES"] ?? "").split(",").filter(Boolean).map(normalizeNimiqAddress);
  if (!nim || !isAddress(polygon) || !/^https:\/\//.test(rpc) || !/^https:\/\//.test(nimRpc) || (!open && owners.length === 0)) throw new DeskError("DESK_NOT_CONFIGURED", "The Polygon payment pilot is not configured.", 503);
  const feeBps = Number(process.env["THENCE_DESK_FEE_BPS"] ?? "50");
  const maxAtomic = BigInt(process.env["THENCE_DESK_MAX_USDC_ATOMIC"] ?? "5000000");
  const minAtomic = BigInt(process.env["THENCE_DESK_MIN_USDC_ATOMIC"] ?? "10000");
  // Floors are fat-finger guards, not a liquidity policy: 0.01 USDC minimum
  // and a 1000 USDC ceiling, with min <= max.
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000 || minAtomic < 10000n || maxAtomic < minAtomic || maxAtomic > 1_000_000_000n) throw new DeskError("DESK_NOT_CONFIGURED", "Invalid pilot limits.", 503);
  return { nimAddress: normalizeNimiqAddress(nim), polygonAddress: getAddress(polygon), rpc, nimRpc, owners, open, feeBps, minAtomic, maxAtomic, enabled: process.env["THENCE_DESK_ENABLED"] === "true" };
}
export function assertDeskOwner(owner: string, newFunding = false) {
  const config = deskConfig();
  const normalized = normalizeNimiqAddress(owner);
  if (!config.open && !config.owners.includes(normalized)) throw new DeskError("DESK_FORBIDDEN", "This pilot is not enabled for this wallet.", 403);
  if (newFunding && !config.enabled) throw new DeskError("DESK_PAUSED", "New treasury payments are paused.", 503);
  return config;
}
