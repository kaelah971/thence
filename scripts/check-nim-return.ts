/**
 * R2 read-only check: has a source NIM HTLC returned in full to its owner?
 *
 * Runs the SAME verifier the close action uses (verifyNimiqHtlcReturn)
 * against a Nimiq JSON-RPC node. No database, no session, no writes: it
 * never closes a transfer, releases exposure, signs or broadcasts anything.
 *
 * Usage:
 *   npx tsx scripts/check-nim-return.ts \
 *     --tx <funding tx hash> --owner "<NQ.. owner address>" \
 *     --hash-lock <64-hex payment hash> --amount <locked luna> \
 *     [--rpc https://rpc.nimiqwatch.com] [--network mainnet] [--min-confirmations 6]
 *
 * Exit code 0 = VERIFIED return; 2 = not (yet) proven; 1 = usage error.
 */
import { verifyNimiqHtlcReturn } from "@/lib/nimiq-source";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const tx = arg("tx");
  const owner = arg("owner");
  const hashLock = arg("hash-lock");
  const amount = arg("amount");
  const rpc = arg("rpc") ?? process.env["THENCE_NIMIQ_PROOF_RPC_URL"] ?? "";
  const network = (arg("network") ?? "mainnet") as "mainnet" | "testnet";
  const minConfirmations = Number(arg("min-confirmations") ?? "6");
  if (!tx || !owner || !hashLock || !amount || !rpc || (network !== "mainnet" && network !== "testnet")) {
    console.error("usage: --tx <hash> --owner <NQ..> --hash-lock <hex> --amount <luna> [--rpc <https url>] [--network mainnet|testnet]");
    return 1;
  }
  const result = await verifyNimiqHtlcReturn({
    fundingTxHash: tx,
    ownerAddress: owner,
    lightningPaymentHash: hashLock,
    expectedAmountLuna: amount,
    config: { url: rpc, network, minConfirmations },
  });
  const host = (() => {
    try {
      return new URL(rpc).host;
    } catch {
      return "invalid";
    }
  })();
  if (!result.ok) {
    console.log(JSON.stringify({ verdict: "NOT_PROVEN", code: result.code, rpcHost: host, checkedAt: new Date().toISOString() }, null, 2));
    return 2;
  }
  const e = result.evidence;
  // Addresses are masked; hashes are public chain identifiers.
  const mask = (a: string) => a.replace(/^(NQ\d\d \w{4}).*( \w{4})$/, "$1 …$2");
  console.log(
    JSON.stringify(
      {
        verdict: "VERIFIED_RETURN",
        rpcHost: host,
        resolution: e.resolution,
        fundingTxHash: e.fundingTxHash,
        refundTxHash: e.refundTxHash,
        htlcAddress: mask(e.htlcAddress),
        destination: mask(e.destination),
        lockedLuna: e.lockedLuna,
        returnedLuna: e.returnedLuna,
        feeLuna: e.feeLuna,
        blockNumber: e.blockNumber,
        finalizedByMacroBlock: e.finalizedByMacroBlock,
        historyHashes: e.historyHashes,
        checkedAt: e.verifiedAt,
      },
      null,
      2,
    ),
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error("check failed");
    process.exit(1);
  },
);
