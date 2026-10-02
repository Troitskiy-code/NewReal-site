import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['scripts/verify-guest-p1.mjs'], {
  env: { ...process.env, P1_CLOSURE: '1' }, stdio: 'inherit', windowsHide: true,
});
child.on('error', () => { console.error('Cannot start isolated P1 verification'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
