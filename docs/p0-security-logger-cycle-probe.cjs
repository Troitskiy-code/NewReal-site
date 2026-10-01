// Bounded child-process probe: real logger, no credentials, no network.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, LOGTAIL_SOURCE_TOKEN: '', LOGTAIL_INGESTING_HOST: '' };
const prefix = `import { formatErrorLog } from './src/lib/logger.ts';\n`;
const cases = [
  ['finite-array control', `const a = [1,2]; console.log('START'); formatErrorLog('Probe', ['constant event', a]); console.log('DONE');`],
  ['branching cyclic array', `const a = []; a.push(a,a); console.log('START'); formatErrorLog('Probe', ['constant event', a]); console.log('DONE');`],
];
const results = cases.map(([label, code]) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import',
    './scripts/alias-register.mjs', '--input-type=module', '-e', prefix + code], {
    cwd: root, env, encoding: 'utf8', timeout: 3000, maxBuffer: 65536,
  });
  return { label, enteredFormatter: result.stdout?.includes('START') ?? false,
    completed: result.stdout?.includes('DONE') ?? false, exit: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT', elapsedMs: Date.now() - started };
});
const output = { productionUsed: false, externalSinkDisabled: true, timeoutMs: 3000, results };
fs.writeFileSync(path.join(__dirname, 'p0-security-logger-cycle-probe.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
