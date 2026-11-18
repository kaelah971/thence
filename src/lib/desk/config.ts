import { getAddress, isAddress } from "viem";
import { normalizeNimiqAddress } from "@/lib/nimiq";
import { DeskError } from "./policy";

export function deskConfig() {
  const nim = process.env["THENCE_DESK_NIM_ADDRESS"] ?? "";
  const polygon = process.env["THENCE_DESK_POLYGON_ADDRESS"] ?? "";
  const rpc = process.env["THENCE_DESK_POLYGON_RPC"] ?? "";
  const nimRpc = process.env["THENCE_NIMIQ_PROOF_RPC_URL"] ?? "";
  const owners = (process.env["THENCE_DESK_OWNER_ADDRESSES"] ?? "").split(",").filter(Boolean).map(normalizeNimiqAddress);
  if (!nim || !isAddress(polygon) || !/^https:\/\//.test(rpc) || !/^https:\/\//.test(nimRpc) || owners.length === 0) throw new DeskError("DESK_NOT_CONFIGURED", "The Polygon payment pilot is not configured.", 503);
  const feeBps = Number(process.env["THENCE_DESK_FEE_BPS"] ?? "50");
  const maxAtomic = BigInt(process.env["THENCE_DESK_MAX_USDC_ATOMIC"] ?? "5000000");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000 || maxAtomic < 300000n || maxAtomic > 100000000n) throw new DeskError("DESK_NOT_CONFIGURED", "Invalid pilot limits.", 503);
  return { nimAddress: normalizeNimiqAddress(nim), polygonAddress: getAddress(polygon), rpc, nimRpc, owners, feeBps, maxAtomic, enabled: process.env["THENCE_DESK_ENABLED"] === "true" };
}
export function assertDeskOwner(owner: string, newFunding = false) {
  const config = deskConfig();
  if (!config.owners.includes(normalizeNimiqAddress(owner))) throw new DeskError("DESK_FORBIDDEN", "This pilot is not enabled for this wallet.", 403);
  if (newFunding && !config.enabled) throw new DeskError("DESK_PAUSED", "New treasury payments are paused.", 503);
  return config;
}
