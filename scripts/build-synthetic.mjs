// Compile check only; never uses production credentials or a live database.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const env = { ...process.env };
for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|API.*KEY|DATABASE_URL|DIRECT_URL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_build',
  DIRECT_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic_build',
  NEXTAUTH_SECRET: 'synthetic_build_secret_only', NEXTAUTH_URL: 'http://localhost:3000',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000', NEXT_PUBLIC_YANDEX_METRIKA_ID: '999001',
  LOGTAIL_SOURCE_TOKEN: '', LOGTAIL_INGESTING_HOST: '', RESEND_API_KEY: '',
});
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  env, stdio: 'inherit', windowsHide: true,
});
child.on('error', () => { console.error('Synthetic build could not start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
