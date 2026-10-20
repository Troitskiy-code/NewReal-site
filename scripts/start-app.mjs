import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { startAllvpnGateway } from './lib/allvpn-runtime.mjs';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';
import { startMemoryWorker } from './lib/memory-worker.mjs';

// Match Next's local precedence while keeping deployment variables authoritative.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
let app, characterWorker, memoryWorker, gateway, gatewayTimer, starting = false, stopping = false;
const enabled = process.env.ALLVPN_ENABLED === '1';
const forced = process.env.DEEPINFRA_NETWORK_MODE === 'allvpn';
const report = event => console.log(JSON.stringify(event));

async function ensureGateway() {
  if (starting || stopping || gateway?.isRunning()) return;
  starting = true;
  try {
    await gateway?.stop(); gateway = undefined;
    gateway = await startAllvpnGateway({ onEvent: report });
    if (stopping) { await gateway.stop(); gateway = undefined; }
  } catch { report({ event: 'allvpn_unavailable', forced }); }
  finally { starting = false; }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(gatewayTimer);
  characterWorker?.stop();
  memoryWorker?.stop();
  app?.kill();
  await gateway?.stop();
  process.exitCode = code;
}

async function main() {
  const mode = process.argv.includes('--dev') ? 'dev' : 'start';
  if (mode === 'start' && ['1', 'true'].includes(process.env.MEMORY_V2_ENABLED) && !process.env.CRON_SECRET)
    throw new Error('MEMORY_V2_ENABLED requires CRON_SECRET for durable processing');
  if (forced && !enabled) throw new Error('AllVPN must be enabled for forced mode');
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  if (enabled) {
    // Private loopback listener; never exposed through the application's public port.
    process.env.ALLVPN_PROXY_URL = 'http://127.0.0.1:18080';
    await ensureGateway();
    if (stopping) return;
    if (forced && !gateway) throw new Error('AllVPN unavailable in forced mode');
    gatewayTimer = setInterval(() => { void ensureGateway(); }, 30_000);
    gatewayTimer.unref();
  }
  process.env.CHARACTER_GENERATION_WORKER_ACTIVE = mode === 'start' && process.env.CRON_SECRET
    && process.env.CHARACTER_GENERATION_WORKER_ENABLED !== '0' ? '1' : '0';
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', mode,
    ...(mode === 'start' ? ['--hostname', '0.0.0.0'] : [])],
  { stdio: 'inherit', windowsHide: true, env: process.env });
  app.once('error', () => { void shutdown(1); });
  app.once('exit', code => { void shutdown(code ?? 1); });
  if (process.env.CHARACTER_GENERATION_WORKER_ACTIVE === '1')
    characterWorker = startCharacterGenerationWorker({ onEvent: report });
  if (mode === 'start' && ['1', 'true'].includes(process.env.MEMORY_V2_ENABLED)
    && process.env.MEMORY_V2_WORKER_ENABLED !== '0') memoryWorker = startMemoryWorker({ onEvent: report });
}

main().catch(() => { report({ event: 'app_start_failed' }); void shutdown(1); });
