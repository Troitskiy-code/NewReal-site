import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const folder = await mkdtemp(join(tmpdir(), 'newreal-startup-'));
const wrapper = resolve('scripts/start-app.mjs');
await mkdir(join(folder, 'node_modules/next/dist/bin'), { recursive: true });
await writeFile(join(folder, '.env.local'), 'ALLVPN_ENABLED=1\nALLVPN_SUBSCRIPTION_URL=https://must-not-be-used.invalid/private\nCRON_SECRET=wrong-local-secret\n');
await writeFile(join(folder, 'node_modules/next/dist/bin/next'), `
const http = require('node:http');
const mode = process.argv[2];
const active = process.env.CHARACTER_GENERATION_WORKER_ACTIVE;
if (active !== process.env.EXPECT_WORKER || mode !== process.env.EXPECT_MODE
  || process.env.CRON_SECRET !== 'synthetic-startup-secret'
  || (mode === 'start' && !process.argv.includes('0.0.0.0'))
  || (mode === 'dev' && process.argv.includes('--hostname'))) process.exit(2);
console.log(JSON.stringify({event:'next_started',fixturePid:process.pid,mode,workerActive:active}));
if (process.env.FAKE_NEXT_EXIT) process.exit(Number(process.env.FAKE_NEXT_EXIT));
if (active !== '1') process.exit(0);
const server = http.createServer((req,res) => {
  const ok = req.method === 'POST' && req.url === '/api/cron/generate-characters'
    && req.headers.authorization === 'Bearer synthetic-startup-secret';
  res.writeHead(ok ? 204 : 403); res.end();
  if (ok) { console.log(JSON.stringify({event:'worker_request_authenticated'}));
    server.close(); setTimeout(() => process.exit(0), 50); }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`);

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(ok => probe.close(ok));
  return port;
}
async function run({ dev = false, worker = true, exit = 0 } = {}) {
  const expected = !dev && worker ? '1' : '0';
  const env = { ...process.env, PORT: String(await freePort()), CRON_SECRET: 'synthetic-startup-secret',
    ALLVPN_ENABLED: '1', ALLVPN_SUBSCRIPTION_URL: 'https://must-not-be-used.invalid/private',
    CHARACTER_GENERATION_WORKER_ENABLED: worker ? '1' : '0', EXPECT_WORKER: expected,
    EXPECT_MODE: dev ? 'dev' : 'start', FAKE_NEXT_EXIT: exit ? String(exit) : '' };
  delete env.NODE_OPTIONS;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[key];
  const child = spawn(process.execPath, [wrapper, ...(dev ? ['--dev'] : [])],
    { cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const timer = setTimeout(() => {
    const ready = output.split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}})
      .find(row=>row?.event==='next_started' && Number.isInteger(row.fixturePid));
    if (ready) { try { process.kill(ready.fixturePid); } catch {} }
    child.kill();
  }, 15000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, exit, `wrapper exit: ${errors.slice(0, 200)} ${output.slice(0, 800)}`);
  assert.ok(output.includes('next_started'), 'Next process starts');
  assert.equal(output.includes('worker_request_authenticated'), expected === '1' && !exit,
    'production worker reaches only the authenticated loopback endpoint');
  assert.ok(!output.includes('allvpn_ready') && !output.includes('allvpn_unavailable'), 'obsolete VPN flags do not start a gateway');
}
try {
  await run(); console.log('PASS production startup retains the authenticated character worker without a VPN runtime');
  await run({ worker: false }); console.log('PASS worker disable flag remains effective');
  await run({ dev: true }); console.log('PASS development starts Next without a production worker');
  await run({ exit: 7 }); console.log('PASS child failure stops the worker and preserves the failure exit code');
} finally {
  const absolute = resolve(folder);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('newreal-startup-')) throw new Error('Unsafe fixture cleanup path');
  await rm(absolute, { recursive: true, force: true });
}
