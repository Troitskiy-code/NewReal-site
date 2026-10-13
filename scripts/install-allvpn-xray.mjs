import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Pinned official release and asset hashes obtained from the GitHub release API.
export const XRAY_VERSION = 'v26.3.27';
const releases = {
  'win32-x64': ['Xray-windows-64.zip', 'd004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad'],
  'linux-x64': ['Xray-linux-64.zip', '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae'],
  'linux-arm64': ['Xray-linux-arm64-v8a.zip', '4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c'],
};
let phase = 'platform';
async function main() {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release) throw new Error('unsupported_platform');
  const folder = resolve(process.argv[2] || '.runtime/allvpn');
  await mkdir(folder, { recursive: true });
  const [asset, hash] = release;
  phase = 'download';
  const response = await fetch(`https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('download_failed');
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== hash) throw new Error('checksum_failed');
  const zipPath = join(folder, 'xray.zip');
  await writeFile(zipPath, archive);
  const run = promisify(execFile);
  phase = 'extract';
  if (process.platform === 'win32') {
    await run('tar.exe', ['-xf', zipPath, '-C', folder], { windowsHide: true });
  } else await run('unzip', ['-o', zipPath, '-d', folder]);
  const binary = join(folder, process.platform === 'win32' ? 'xray.exe' : 'xray');
  phase = 'binary';
  await readFile(binary); await chmod(binary, 0o755);
  console.log(JSON.stringify({ event: 'xray_installed', version: XRAY_VERSION, checksumVerified: true }));
}
main().catch(error => { console.error(JSON.stringify({ event: 'xray_install_failed', phase,
  code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : null })); process.exitCode = 1; });
