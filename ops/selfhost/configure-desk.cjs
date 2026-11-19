#!/usr/bin/env node
// Explicit production operator command. Secrets enter via a protected file, never argv/logs.
// stage -> migrate -> preflight -> enable, with an app restart after env changes.
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const file = '/etc/thence-web-prod/production.env';
const release = fs.realpathSync('/srv/thence-prod/production/current');
const load = createRequire(release + '/package.json');
const { Pool } = load('pg');
const { privateKeyToAccount } = load('viem/accounts');
const { createPublicClient, http, erc20Abi } = load('viem');
const { polygon, arbitrum } = load('viem/chains');
const PAYOUT = '0x21e5fc03e4305cc8cfb874253c6d66a8bdb0bcda';
const COLLECTION = 'NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ';
function requireValue(condition, code) { if (!condition) throw new Error(code); }
function writeConfig(values) {
  const original = fs.readFileSync(file, 'utf8'), stat = fs.statSync(file);
  const backup = file + '.pre-desk';
  if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); }
  let content = original;
  for (const [key, value] of Object.entries(values)) {
    requireValue(typeof value === 'string' && !/[\r\n\\]/.test(value), 'INVALID_CONFIG_VALUE');
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, () => line) : content.trimEnd() + '\n' + line + '\n';
  }
  const temporary = file + '.desk-incoming-' + process.pid;
  fs.writeFileSync(temporary, content, { mode: 0o640, flag: 'wx' });
  fs.chownSync(temporary, stat.uid, stat.gid);
  fs.renameSync(temporary, file);
}
async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const body = await response.json();
  requireValue(response.ok && !body.error, 'NIM_RPC_UNAVAILABLE');
  return body.result?.data ?? body.result;
}
async function main() {
  requireValue(process.getuid() === 0, 'ROOT_REQUIRED');
  const mode = process.argv[2];
  requireValue(['stage', 'migrate', 'preflight', 'enable', 'pause'].includes(mode), 'INVALID_MODE');
  const env = parseEnv(fs.readFileSync(file, 'utf8'));
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const target = await pool.query("SELECT to_regclass('public.__thence_test_anchor') IS NOT NULL AS test_anchor");
    requireValue(target.rows[0].test_anchor === false && env.THENCE_APP_ORIGIN === 'https://paywiththence.cv', 'PRODUCTION_IDENTITY_MISMATCH');
    if (mode === 'stage') {
      const inputFile = process.argv[3];
      requireValue(/^\/tmp\/thence-desk-signing-[0-9a-f]{32}$/.test(inputFile || ''), 'INVALID_SECRET_FILE');
      const inputStat = fs.lstatSync(inputFile);
      requireValue(inputStat.isFile() && !inputStat.isSymbolicLink() && (inputStat.mode & 0o077) === 0, 'UNSAFE_SECRET_FILE');
      const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
      fs.unlinkSync(inputFile);
      const open = input.open === true;
      requireValue(Array.isArray(input.ownerAddresses) && (open || input.ownerAddresses.length > 0) && input.ownerAddresses.every(address => /^NQ\d{2}( [A-Z0-9]{4}){8}$/.test(address)), 'INVALID_OWNERS');
      const maxAtomic = String(input.maxAtomic ?? '5000000');
      const minAtomic = String(input.minAtomic ?? '10000');
      requireValue(/^[1-9][0-9]{4,9}$/.test(maxAtomic) && /^[1-9][0-9]{4,8}$/.test(minAtomic) && BigInt(minAtomic) >= 10000n && BigInt(maxAtomic) >= BigInt(minAtomic) && BigInt(maxAtomic) <= 1000000000n, 'INVALID_LIMIT');
      const key = String(input.privateKey).trim();
      requireValue(/^0x[0-9a-fA-F]{64}$/.test(key), 'INVALID_SIGNER');
      requireValue(privateKeyToAccount(key).address.toLowerCase() === PAYOUT, 'SIGNER_MISMATCH');
      const rpcs = JSON.parse(env.THENCE_EVM_RPCS_JSON || '{}');
      requireValue(/^https:\/\//.test(rpcs['137'] || '') && /^https:\/\//.test(rpcs['42161'] || '') && /^https:\/\//.test(env.THENCE_NIMIQ_PROOF_RPC_URL || ''), 'RPC_NOT_CONFIGURED');
      requireValue((env.CRON_SECRET || '').length >= 32, 'CRON_NOT_CONFIGURED');
      writeConfig({ THENCE_DESK_ENABLED: 'false', THENCE_DESK_NIM_ADDRESS: COLLECTION, THENCE_DESK_POLYGON_ADDRESS: PAYOUT, THENCE_DESK_OWNER_ADDRESSES: input.ownerAddresses.join(','), THENCE_DESK_OPEN: open ? 'true' : 'false', THENCE_DESK_POLYGON_RPC: rpcs['137'], THENCE_DESK_ARBITRUM_RPC: rpcs['42161'], THENCE_DESK_POLYGON_PRIVATE_KEY: key, THENCE_DESK_MIN_USDC_ATOMIC: minAtomic, THENCE_DESK_MAX_USDC_ATOMIC: maxAtomic, THENCE_DESK_FEE_BPS: '50' });
      fs.writeFileSync('/etc/thence-web-prod/desk-cron-secret', env.CRON_SECRET, { mode: 0o600 });
      fs.chmodSync('/etc/thence-web-prod/desk-cron-secret', 0o600);
      console.log('Desk configuration staged with new payments paused.');
      return;
    }
    if (mode === 'migrate') {
      const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/db/migrate.ts'], { cwd: release, env: { ...process.env, ...env, NODE_ENV: 'production', THENCE_MIGRATE_PRODUCTION: 'I_UNDERSTAND' }, stdio: 'inherit' });
      requireValue(result.status === 0, 'MIGRATION_FAILED'); return;
    }
    if (mode === 'pause') { writeConfig({ THENCE_DESK_ENABLED: 'false' }); console.log('Desk paused; restart app to reload environment.'); return; }
    requireValue(privateKeyToAccount(env.THENCE_DESK_POLYGON_PRIVATE_KEY).address.toLowerCase() === PAYOUT, 'SIGNER_MISMATCH');
    const client = createPublicClient({ chain: polygon, transport: http(env.THENCE_DESK_POLYGON_RPC, { timeout: 8000, retryCount: 0 }) });
    requireValue(await client.getChainId() === 137, 'WRONG_CHAIN');
    const block = await client.getBlock({ blockTag: 'finalized' });
    requireValue(Date.now() - Number(block.timestamp) * 1000 < 300000, 'STALE_FINALITY');
    let arbitrumBalances = null;
    try {
      const arbRpc = env.THENCE_DESK_ARBITRUM_RPC;
      if (arbRpc) {
        const arb = createPublicClient({ chain: arbitrum, transport: http(arbRpc, { timeout: 8000, retryCount: 0 }) });
        const arbBlock = await arb.getBlock({ blockTag: 'finalized' });
        const [arbUsdc, arbGas] = await Promise.all([
          arb.readContract({ address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', abi: erc20Abi, functionName: 'balanceOf', args: [PAYOUT], blockNumber: arbBlock.number }),
          arb.getBalance({ address: PAYOUT, blockNumber: arbBlock.number }),
        ]);
        arbitrumBalances = { usdcAtomic: arbUsdc.toString(), gasWei: arbGas.toString(), block: arbBlock.number };
      }
    } catch { arbitrumBalances = { error: 'ARBITRUM_UNAVAILABLE' }; }
    const [usdc, pol] = await Promise.all([
      client.readContract({ address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', abi: erc20Abi, functionName: 'balanceOf', args: [PAYOUT], blockNumber: block.number }),
      client.getBalance({ address: PAYOUT, blockNumber: block.number }),
    ]);
    requireValue(usdc >= 300000n && pol >= 50000000000000000n, 'TREASURY_BALANCE_LOW');
    const account = await rpc(env.THENCE_NIMIQ_PROOF_RPC_URL, 'getAccountByAddress', [COLLECTION]);
    requireValue(account?.type === 'basic', 'INVALID_COLLECTION_ACCOUNT');
    const history = await rpc(env.THENCE_NIMIQ_PROOF_RPC_URL, 'getTransactionsByAddress', { address: COLLECTION, max: 500 });
    requireValue(Array.isArray(history), 'NIM_HISTORY_UNAVAILABLE');
    const table = await pool.query("SELECT to_regclass('public.desk_orders') IS NOT NULL AS ready");
    requireValue(table.rows[0].ready, 'DESK_SCHEMA_MISSING');
    if (mode === 'enable') {
      requireValue(fs.existsSync('/etc/systemd/system/thence-desk-worker.timer'), 'WORKER_NOT_INSTALLED');
      const enabled = spawnSync('/usr/bin/systemctl', ['is-enabled', '--quiet', 'thence-desk-worker.timer']);
      requireValue(enabled.status === 0, 'WORKER_NOT_ENABLED');
      const active = spawnSync('/usr/bin/systemctl', ['is-active', '--quiet', 'thence-desk-worker.timer']);
      requireValue(active.status === 0, 'WORKER_NOT_ACTIVE');
      const result = spawnSync('/usr/bin/systemctl', ['show', 'thence-desk-worker.service', '-p', 'Result', '--value'], { encoding: 'utf8' });
      requireValue(result.status === 0 && result.stdout.trim() === 'success', 'WORKER_LAST_RUN_FAILED');
      writeConfig({ THENCE_DESK_ENABLED: 'true' });
    }
    console.log(JSON.stringify({ preflight: 'passed', mode, arbitrum: arbitrumBalances, signerMatches: true, nativeUsdcAtomic: usdc.toString(), polWei: pol.toString(), collectionBasic: true, historyReadable: true, open: env.THENCE_DESK_OPEN === 'true', privateOwners: (env.THENCE_DESK_OWNER_ADDRESSES || '').split(',').filter(Boolean).length }));
  } finally { await pool.end(); }
}
main().catch(error => {
  const code = /^[A-Z_]{3,80}$/.test(error?.message || '') ? error.message : 'OPERATION_UNAVAILABLE';
  console.error(`Desk operation failed: ${code}`); process.exitCode = 1;
});
