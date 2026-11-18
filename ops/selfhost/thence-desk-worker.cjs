#!/usr/bin/env node
// The worker only requests server-owned, verified treasury payouts over loopback.
// The bearer credential never appears in argv, files, or log output.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

async function tick({ credentialDirectory, fetcher = fetch, log = console.log }) {
  const secret = readFileSync(join(credentialDirectory, 'cron-secret'), 'utf8').trim();
  if (secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('Credential unavailable');
  const response = await fetcher('http://127.0.0.1:3200/api/cron/desk', {
    headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`Desk endpoint HTTP ${response.status}`);
  const body = await response.json();
  const summary = {};
  for (const key of ['checked', 'delivered', 'refundDue', 'errors', 'ambiguous']) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw new Error('Invalid worker response');
    summary[key] = body[key];
  }
  log(`thence-desk-worker ${JSON.stringify(summary)}`);
  return summary;
}
module.exports = { tick };
if (require.main === module) {
  tick({ credentialDirectory: process.env.CREDENTIALS_DIRECTORY || '/nonexistent' }).catch(() => {
    console.error('thence-desk-worker failed; inspect the authenticated endpoint and service health');
    process.exitCode = 1;
  });
}
