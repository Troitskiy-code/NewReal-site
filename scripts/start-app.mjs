import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';

// Match Next's local precedence while keeping deployment variables authoritative.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
let app, characterWorker, stopping = false;
const report = event => console.log(JSON.stringify(event));

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  characterWorker?.stop();
  app?.kill();
  process.exitCode = code;
}

function main() {
  const mode = process.argv.includes('--dev') ? 'dev' : 'start';
  process.env.CHARACTER_GENERATION_WORKER_ACTIVE = mode === 'start' && process.env.CRON_SECRET
    && process.env.CHARACTER_GENERATION_WORKER_ENABLED !== '0' ? '1' : '0';
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', mode,
    ...(mode === 'start' ? ['--hostname', '0.0.0.0'] : [])],
  { stdio: 'inherit', windowsHide: true, env: process.env });
  app.once('error', () => { shutdown(1); });
  app.once('exit', code => { shutdown(code ?? 1); });
  if (process.env.CHARACTER_GENERATION_WORKER_ACTIVE === '1')
    characterWorker = startCharacterGenerationWorker({ onEvent: report });
  process.once('SIGINT', () => { shutdown(); });
  process.once('SIGTERM', () => { shutdown(); });
}

try { main(); }
catch { report({ event: 'app_start_failed' }); shutdown(1); }
