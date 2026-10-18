import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';
import { startMemoryWorker } from './lib/memory-worker.mjs';

// Match Next's local precedence while keeping deployment variables authoritative.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
let app, characterWorker, memoryWorker, stopping = false;
const report = event => console.log(JSON.stringify(event));

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  characterWorker?.stop();
  memoryWorker?.stop();
  app?.kill();
  process.exitCode = code;
}

function main() {
  const mode = process.argv.includes('--dev') ? 'dev' : 'start';
  if (mode === 'start' && ['1', 'true'].includes(process.env.MEMORY_V2_ENABLED) && !process.env.CRON_SECRET)
    throw new Error('MEMORY_V2_ENABLED requires CRON_SECRET for durable processing');
  process.env.CHARACTER_GENERATION_WORKER_ACTIVE = mode === 'start' && process.env.CRON_SECRET
    && process.env.CHARACTER_GENERATION_WORKER_ENABLED !== '0' ? '1' : '0';
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', mode,
    ...(mode === 'start' ? ['--hostname', '0.0.0.0'] : [])],
  { stdio: 'inherit', windowsHide: true, env: process.env });
  app.once('error', () => { shutdown(1); });
  app.once('exit', code => { shutdown(code ?? 1); });
  if (process.env.CHARACTER_GENERATION_WORKER_ACTIVE === '1')
    characterWorker = startCharacterGenerationWorker({ onEvent: report });
  if (mode === 'start' && ['1', 'true'].includes(process.env.MEMORY_V2_ENABLED)
    && process.env.MEMORY_V2_WORKER_ENABLED !== '0') memoryWorker = startMemoryWorker({ onEvent: report });
  process.once('SIGINT', () => { shutdown(); });
  process.once('SIGTERM', () => { shutdown(); });
}

try { main(); }
catch { report({ event: 'app_start_failed' }); shutdown(1); }
