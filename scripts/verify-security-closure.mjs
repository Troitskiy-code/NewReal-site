// Isolated real-handler probes: no env files, production DB, counter or AI requests.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import ts from 'typescript';
import * as crypto from 'node:crypto';

let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const marker = 'SYNTHETIC_UNKNOWN_ERROR_VALUE';
const env = { CREATEYA_API_KEY: 'synthetic_placeholder', KIE_API_KEY: 'synthetic_placeholder' };
const errors = [new Error(marker), { message: marker }, { name: 'AxiosError', message: marker, config: { headers: { Authorization: marker } } }];
let fault = errors[0];
let avatarFixture;
let sessionUser = 'fixture_owner';
let serverFetches = 0;
const serverFetch = () => { serverFetches++; throw new Error('Network must be mocked'); };
const logLines = [];
const sinkLines = [];
const fakeConsole = { error: (...args) => logLines.push(args.map(String).join(' ')), warn: (...args) => logLines.push(args.map(String).join(' ')), log() {}, info() {} };
const throwing = async () => { throw fault; };
const database = new Proxy({}, { get: (_target, name) => name === 'character'
  ? { findUnique: async () => { if (avatarFixture !== undefined) return avatarFixture; return throwing(); } }
  : new Proxy({}, { get: () => throwing }) });
let reserved = 0;
const nextResponse = class extends Response {};
const mocks = {
  'node:crypto': crypto,
  'next/server': { NextRequest: Request, NextResponse: nextResponse },
  'next-auth/next': { getServerSession: async () => ({ user: { id: sessionUser } }) },
  '@/lib/auth': { authOptions: {} },
  '@/lib/prisma': { prisma: database },
  '@/lib/handlePrismaError': { prismaPoolOverloadResponse: () => null },
  '@logtail/node': { Logtail: class { constructor() { throw new Error('No live sink allowed'); } } },
  '@/lib/personaService': { listUserPersonas: throwing, assignPersonaToChat: async () => ({}), toChatPersona: value => value },
  '@/lib/avatarTokens': { reserveAvatarGeneration: async () => { reserved++; return { id: 'fixture_reservation', user: {}, isNew: true,
    generation: { id: 'fixture_reservation', scope: 'create:character', state: 'creating' } }; }, AvatarRequestConflict: class extends Error {}, getAvatarUsageUser: async () => ({}), settleAvatarGeneration: async () => {}, getAvatarTokenStatus: () => ({}) },
  '@/lib/kieAi': { KieError: class extends Error {}, hasKieKey: () => true, prepareKieReference: async value => value,
    uploadKieReference: async () => 'https://tempfile.redpandaai.co/fixture.png', createKieAvatar: throwing },
  '@/lib/kieAvatarJobs': { finishAvatarJob: async job => ({ ...job, state: 'failed' }), publicAvatarJob: job => ({ jobId: job.id, state: job.state }) },
  '@/lib/avatarPrompt': { buildAvatarPrompt: () => 'fixture prompt', resolveAvatarStyle: () => 'fixture', isSensitiveGenerationError: () => false, SENSITIVE_CLIENT_MESSAGE: 'fixture' },
  '@/lib/avatarModels': { getAvatarModel: () => ({ id: 'fixture', costMultiplier: 1 }), resolveCreateyaAvatarModel: () => 'fixture' },
  '@/lib/avatarEconomy': { AVATAR_BASE_COST_RUB: 5 },
  '@/lib/aiCostTelemetry': { withAiCostContext: work => work(), setAiCostActor() {}, recordKieAvatarCost: async () => {}, withAvatarCost: async (_model, _cost, work) => work(() => {}) },
  '@/lib/createya': { convertImageToPNG: async value => value, generateWithCreateya: async () => 'data:image/png;base64,AAAA', imageUrlToDataUrl: async value => value },
};
const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', 'process', 'console', 'fetch', code)(name => {
    if (name in mocks) return mocks[name];
    if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts');
    if (name.startsWith('./') || name.startsWith('../')) return load(resolve(dirname(file), name + '.ts'));
    throw new Error('Unexpected import: ' + name);
  }, loadedModule, loadedModule.exports, { env }, fakeConsole, serverFetch);
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const logger = load('src/lib/logger.ts');
logger.setDiagnosticSink({ debug: value => sinkLines.push(value), info: value => sinkLines.push(value), error: value => sinkLines.push(value), flush() {} });

const download = load('src/app/api/download/route.js');
for (const url of ['http://127.0.0.1/private', 'http://169.254.169.254/fixture', 'https://example.invalid/image.png', 'file:///fixture', 'data:text/html,fixture']) {
  const response = await download.GET(new Request('https://example.invalid/api/download?url=' + encodeURIComponent(url)));
  check(response.status === 410 && !response.headers.has('location'), 'retired proxy neither fetches nor redirects');
}
const exporter = load('src/app/api/app-instances/export/route.js');
check((await exporter.POST()).status === 410, 'server export is disabled before auth/FS/network');
check(serverFetches === 0, 'disabled endpoints perform no upstream request');

const cases = [
  ['src/app/api/characters/[id]/avatar/route.ts', 'GET', () => [new Request('https://example.invalid/avatar'), { params: Promise.resolve({ id: 'fixture' }) }]],
  ['src/app/api/app-instances/route.js', 'GET', () => [new Request('https://example.invalid/api/app-instances')]],
  ['src/app/api/app-instances/route.js', 'POST', () => [new Request('https://example.invalid/api/app-instances', { method: 'POST', body: JSON.stringify({ name: 'fixture', templateId: 'fixture' }) })]],
  ['src/app/api/app-instances/route.js', 'DELETE', () => [new Request('https://example.invalid/api/app-instances?id=fixture', { method: 'DELETE' })]],
  ['src/app/api/upload/route.js', 'POST', () => [{ formData: throwing }]],
  ['src/app/api/personas/route.ts', 'GET', () => [new Request('https://example.invalid/api/personas')]],
  ['src/app/api/personas/route.ts', 'POST', () => [new Request('https://example.invalid/api/personas', { method: 'POST', body: JSON.stringify({ name: 'fixture' }) })]],
];
for (const error of errors) {
  fault = error;
  for (const [file, method, args] of cases) {
    const response = await load(file)[method](...args());
    check(response.status === 500, file + ': unknown failure returns 500');
    check(!(await response.text()).includes(marker), file + ': no caught payload in HTTP response');
  }
}
await Promise.resolve();
check(logLines.length > 0 && sinkLines.length > 0, 'console and diagnostic sink both tested');
check(logLines.every(line => !line.includes(marker)) && sinkLines.every(line => !line.includes(marker)), 'unknown errors absent from both log channels');

const { ClientInputError, publicError } = load('src/lib/publicError.ts');
check(publicError(new ClientInputError('Имя обязательно'), 'fallback').status === 400, 'controlled validation remains 400');
check(publicError(new Error(marker + ' не длиннее лимита'), 'fallback').message === 'fallback', 'unknown error cannot impersonate validation by text');
check(load('src/lib/persona.ts').parsePersonaPayload({ name: 'fixture' }).name === 'fixture', 'valid persona parser still works');

const events = load('src/app/api/events/route.ts');
for (const [invalid, expected] of [
  [{ participants: marker }, 'participants должен быть массивом ID персонажей'],
  [{ participants: Array(51).fill('fixture') }, 'Не больше 50 участников'],
  [{ importance: 6 }, 'importance должен быть целым числом от 1 до 5'],
  [{ importance: { valueOf: marker, toString: marker } }, 'Некорректные данные'],
]) {
  const response = await events.POST(new Request('https://example.invalid/api/events', { method: 'POST',
    body: JSON.stringify({ characterId: 'fixture', type: 'conversation', description: 'fixture', ...invalid }) }));
  const body = await response.json();
  check(response.status === 400 && body.error === expected && !JSON.stringify(body).includes(marker), 'event validation keeps controlled messages and hides unexpected failures');
}

const avatarReader = load('src/app/api/characters/[id]/avatar/route.ts');
const readAvatar = () => avatarReader.GET(new Request('https://example.invalid/avatar'), { params: Promise.resolve({ id: 'fixture' }) });
avatarFixture = { imageUrl: 'data:image/png;base64,AAAA', isPublic: false, userId: 'fixture_owner' };
let privateAvatar = await readAvatar();
check(privateAvatar.status === 200 && privateAvatar.headers.get('cache-control') === 'private, no-store', 'private owner avatar is never publicly cached');
check(privateAvatar.headers.get('x-content-type-options') === 'nosniff', 'avatar MIME is not browser-sniffed');
sessionUser = 'fixture_stranger';
check((await readAvatar()).status === 404, 'private avatar is hidden from another account');
avatarFixture.isPublic = true;
check((await readAvatar()).headers.get('cache-control').startsWith('public,'), 'public raster avatar remains cacheable');
for (const mime of ['image/svg+xml', 'image/png+xml', 'text/html']) {
  avatarFixture.imageUrl = `data:${mime};base64,AAAA`;
  check((await readAvatar()).status === 404, 'active/unknown data content is never served from the avatar origin');
}
avatarFixture = undefined;
sessionUser = 'fixture_owner';

const avatar = load('src/app/api/generate-avatar/route.ts');
for (const referenceImage of ['http://127.0.0.1/private', 'https://example.invalid/reference.png', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA']) {
  const response = await avatar.POST(new Request('https://example.invalid/api/generate-avatar', { method: 'POST', body: JSON.stringify({ name: 'fixture', scope: 'create:character', clientKey: 'fixture_client_key_123', referenceImage }) }));
  check(response.status === 400 && reserved === 0 && (await response.text()).includes('PNG'), 'invalid avatar reference rejected before quota/provider');
}
check((await avatar.POST(new Request('https://example.invalid/api/generate-avatar', { method: 'POST', body: JSON.stringify({ name: 'fixture', scope: 'create:character', clientKey: 'fixture_client_key_123', referenceImage: 'data:image/png;base64,AAAA' }) }))).status === 202 && reserved === 1, 'valid reference reaches reservation; safe asynchronous provider failure response');

function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : /route\.(js|ts)$/.test(e.name) ? [join(dir, e.name)] : []); }
for (const file of walk('src/app/api')) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'console') {
      check(!['error', 'warn'].includes(node.expression.name.text), file + ': no direct console failure logging');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

check(serverFetches === 0, 'all probes performed without a real upstream request');
console.log(`Security closure: ${checks} checks passed`);
