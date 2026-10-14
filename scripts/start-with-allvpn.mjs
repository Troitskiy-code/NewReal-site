import { spawn } from 'node:child_process';
import { loadAllvpnEnv, startAllvpnGateway } from './lib/allvpn-runtime.mjs';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';

loadAllvpnEnv();
let gateway, app, timer, characterWorker, starting = false, stopping = false;
const enabled = process.env['ALLVPN_ENABLED'] === '1';
const forced = process.env['DEEPINFRA_NETWORK_MODE'] === 'allvpn';
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
  stopping = true; clearInterval(timer);
  characterWorker?.stop();
  app?.kill();
  await gateway?.stop();
  process.exitCode = code;
}
async function main() {
  if (forced && !enabled) throw new Error('AllVPN must be enabled for forced mode');
  if (enabled) {
    // This is loopback inside the same container, independent of the platform's public port 8080.
    process.env['ALLVPN_PROXY_URL'] = 'http://127.0.0.1:18080';
    await ensureGateway();
    if (forced && !gateway) throw new Error('AllVPN unavailable in forced mode');
    timer = setInterval(() => { void ensureGateway(); }, 30000); timer.unref();
  }
  const mode = process.argv.includes('--dev') ? 'dev' : 'start';
  process.env.CHARACTER_GENERATION_WORKER_ACTIVE = mode === 'start' && process.env.CRON_SECRET
    && process.env.CHARACTER_GENERATION_WORKER_ENABLED !== '0' ? '1' : '0';
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', mode, ...(mode === 'start' ? ['--hostname', '0.0.0.0'] : [])],
    { stdio: 'inherit', windowsHide: true, env: process.env });
  app.once('error', () => { void shutdown(1); });
  app.once('exit', code => { void shutdown(code ?? 1); });
  if (process.env.CHARACTER_GENERATION_WORKER_ACTIVE === '1')
    characterWorker = startCharacterGenerationWorker({ onEvent: report });
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
}
main().catch(() => { report({ event: 'app_start_failed', reason: 'allvpn_configuration_or_connection' }); void shutdown(1); });
