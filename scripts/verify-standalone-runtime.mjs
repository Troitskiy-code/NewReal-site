import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
for (const file of [
  'server.js', '.next/BUILD_ID', '.next/static', 'public/locales/manifest.json',
  'prisma/migrations/20261006120000_support_replies/migration.sql',
]) await access(file);
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  await assert.rejects(access(file), { code: 'ENOENT' });
}

require('dotenv');
assert.equal(typeof require('undici').ProxyAgent, 'function');
assert.equal(typeof require('@prisma/client').PrismaClient, 'function');
const engines = {
  'linux-x64': 'libquery_engine-debian-openssl-3.0.x.so.node',
  'linux-arm64': 'libquery_engine-linux-arm64-openssl-3.0.x.so.node',
  'win32-x64': 'query_engine-windows.dll.node',
};
const engine = engines[`${process.platform}-${process.arch}`];
assert.ok(engine, 'Expected a native Prisma engine for this platform');
assert.equal(typeof require(resolve('node_modules/.prisma/client', engine)).QueryEngine, 'function');

const sharp = require('sharp');
const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).webp().toBuffer();
const { default: decode, init } = await import('@jsquash/webp/decode.js');
const wasm = await readFile('node_modules/@jsquash/webp/codec/dec/webp_dec.wasm');
await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
const image = await decode(webp.buffer.slice(webp.byteOffset, webp.byteOffset + webp.byteLength));
assert.deepEqual([image.width, image.height], [4, 4]);

const encoder = require('tiktoken').get_encoding('cl100k_base');
try { assert.ok(encoder.encode('NewVerse').length > 0); }
finally { encoder.free(); }

if (process.env.ALLVPN_XRAY_PATH) execFileSync(process.env.ALLVPN_XRAY_PATH, ['version'], { stdio: 'ignore' });
console.log('Standalone runtime assets and native modules verified');
