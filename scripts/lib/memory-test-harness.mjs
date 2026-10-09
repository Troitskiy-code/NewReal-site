// Isolated memory test harness: embedded PostgreSQL (GUEST_TEST_RUNTIME), in-process
// PGlite + pgvector for vector SQL, and an in-process fake AI provider.
// Never loads .env, never touches DATABASE_URL, never calls real providers.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const EMBEDDING_DIMENSIONS = 1536;

export function fakeEmbedding(text) {
  const values = new Array(EMBEDDING_DIMENSIONS).fill(0);
  const words = String(text).toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  for (const word of words) {
    let hash = 2166136261;
    for (const ch of word.slice(0, 5)) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    values[Math.abs(hash) % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function axiosError(status) {
  return Object.assign(new Error(`fake provider status ${status}`), {
    isAxiosError: true,
    response: { status, data: {}, headers: {} },
  });
}

export function createFakeProvider() {
  const provider = {
    intent: 'general',
    reply: 'Персонаж отвечает спокойно.',
    coreText: 'UNCHANGED',
    summaryText: null,
    summaryFails: false,
    embeddingsFail: false,
    consolidationFails: false,
    beforeSummary: null,
    beforeCore: null,
    beforeEmbedding: null,
    classify: () => ({ isEvent: false, importance: 1, text: '' }),
    calls: [],
    chatRequests: [],
    inflight: 0,
    total: 0,
    reset() {
      Object.assign(provider, {
        intent: 'general', reply: 'Персонаж отвечает спокойно.', coreText: 'UNCHANGED', summaryText: null,
        summaryFails: false, embeddingsFail: false, consolidationFails: false, beforeSummary: null, beforeCore: null, beforeEmbedding: null,
        classify: () => ({ isEvent: false, importance: 1, text: '' }),
      });
      provider.calls = [];
      provider.chatRequests = [];
    },
    kindOf(body) {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const all = messages.map((m) => String(m.content ?? '')).join('\n');
      const system = String(messages[0]?.content ?? '');
      if (all.includes('классификатор намерений')) return 'intent';
      if (all.includes('"isEvent"')) return 'classifier';
      if (system.startsWith('Ты — анализатор устойчивых фактов')) return 'core';
      if (system.startsWith('Ты — редактор')) return 'consolidation';
      if (system.startsWith('Ты — суммаризатор')) return 'summary';
      return 'other';
    },
    async axiosPost(url, body) {
      provider.inflight += 1;
      provider.total += 1;
      try {
        await new Promise((done) => setImmediate(done));
        if (String(url).endsWith('/embeddings')) {
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          provider.calls.push({ kind: 'embedding', inputs });
          if (provider.beforeEmbedding) await provider.beforeEmbedding(inputs);
          if (provider.embeddingsFail) throw axiosError(503);
          return {
            status: 200,
            headers: {},
            data: {
              id: 'gen_fake_embedding',
              model: body.model,
              usage: { prompt_tokens: 10 * inputs.length, total_tokens: 10 * inputs.length },
              data: inputs.map((text, index) => ({ index, embedding: fakeEmbedding(text) })),
            },
          };
        }
        if (!String(url).endsWith('/chat/completions')) throw new Error(`Unexpected provider URL ${url}`);
        const kind = provider.kindOf(body);
        const prompt = (body.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
        provider.calls.push({ kind, model: body.model, prompt });
        let content;
        if (kind === 'intent') content = JSON.stringify({ intent: provider.intent, confidence: 0.9 });
        else if (kind === 'classifier') content = JSON.stringify(provider.classify(prompt));
        else if (kind === 'core') {
          if (provider.beforeCore) await provider.beforeCore();
          content = provider.coreText;
        }
        else if (kind === 'consolidation') {
          if (provider.consolidationFails) throw axiosError(503);
          content = prompt.split('\n').filter((line) => line.startsWith('- ')).slice(0, 5).join('\n');
        } else if (kind === 'summary') {
          if (provider.beforeSummary) await provider.beforeSummary();
          if (provider.summaryFails) throw axiosError(503);
          if (provider.summaryText !== null) content = provider.summaryText;
          else if (prompt.includes('MEMORY_SUMMARY_SELECTION_V1')) {
            const sources = JSON.parse(body.messages[1].content).sources;
            content = JSON.stringify({ activeLines: [], events: sources.slice(0, 3).map((source) => source.id) });
          } else content = '## Активные линии\n- Хранитель маяка помогает гостю.\n\n## Недавние события\n1. Гость пришёл к маяку.\n\n## Эмоциональный фон\nСпокойный.';
        } else content = 'ok';
        return {
          status: 200,
          headers: {},
          data: { id: 'gen_fake_chat', model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
        };
      } finally {
        provider.inflight -= 1;
      }
    },
    async fetch(url, init) {
      if (String(url) !== 'https://api.kodikrouter.ru/v1/chat/completions') {
        throw new Error(`External fetch forbidden in memory harness: ${url}`);
      }
      const body = JSON.parse(String(init.body));
      provider.total += 1;
      provider.chatRequests.push({ body, at: performance.now() });
      provider.calls.push({ kind: 'chat' });
      const frames = [
        `data: ${JSON.stringify({ id: 'gen_fake_stream', model: body.model, choices: [{ delta: { content: provider.reply } }] })}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50 } })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  };
  return provider;
}

/** CommonJS loader for project TS sources with dependency overrides (prisma, auth, FX). */
export function createModuleLoader({ prismaFor, session = { userId: null }, sourceRef = null, sourceTransform = (file, source) => source }) {
  let revision = null;
  if (sourceRef) {
    const resolved = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', sourceRef], { cwd: root, encoding: 'utf8' });
    revision = resolved.stdout?.trim();
    if (resolved.status !== 0 || !/^[a-f0-9]{40}$/i.test(revision ?? '')) throw new Error('Invalid baseline Git revision');
  }
  const cache = new Map();
  const resolveSource = (base) => {
    if (/\.(ts|tsx|js|mjs|cjs|json)$/i.test(base) && existsSync(base)) return base;
    return [`${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')].find((file) => existsSync(file));
  };
  const load = (file) => {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file);
    if (file.endsWith('.json')) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      cache.set(file, json);
      return json;
    }
    const loadedModule = { exports: {} };
    cache.set(file, loadedModule.exports);
    let source = readFileSync(file, 'utf8');
    if (revision && relative(root, file).split(/[\\/]/)[0] === 'src') {
      const path = relative(root, file).replaceAll('\\', '/');
      const snapshot = spawnSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (snapshot.status !== 0) throw new Error(`Missing baseline source: ${path}`);
      source = snapshot.stdout;
    }
    const code = ts.transpileModule(sourceTransform(file, source), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText;
    const dependency = (name) => {
      if (name === '@/lib/prisma') return { prisma: prismaFor(file) };
      if (name === 'next-auth/next') return { getServerSession: async () => (session.userId ? { user: { id: session.userId } } : null) };
      if (name === '@/lib/auth') return { authOptions: {} };
      if (name === './currencyRates' || name === '@/lib/currencyRates') return { getAccountingUsdRub: async () => null };
      if (name.startsWith('@/')) {
        const target = resolveSource(join(root, 'src', name.slice(2)));
        if (!target) throw new Error(`Cannot resolve ${name}`);
        return load(target);
      }
      if (name.startsWith('.')) {
        const target = resolveSource(resolve(dirname(file), name));
        if (!target) throw new Error(`Cannot resolve ${name} from ${file}`);
        return load(target);
      }
      return require(name);
    };
    new Function('require', 'module', 'exports', code)(dependency, loadedModule, loadedModule.exports);
    cache.set(file, loadedModule.exports);
    return loadedModule.exports;
  };
  return { load, root };
}

function sqlFromTemplate(strings, values) {
  let text = '';
  strings.forEach((part, index) => {
    text += part;
    if (index < values.length) text += `$${index + 1}`;
  });
  return { text, values };
}

export async function startHarness({ label = 'memory', realProvider = false, sourceRef = null, sourceTransform } = {}) {
  const runtime = process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime');
  const modulePath = join(runtime, 'node_modules/embedded-postgres/dist/index.js');
  if (!existsSync(modulePath)) throw new Error('Set GUEST_TEST_RUNTIME to an isolated embedded-postgres installation');
  const EmbeddedPostgres = require(modulePath).default;
  const port = await new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });
  const directory = mkdtempSync(join(tmpdir(), `nv-${label}-`));
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_memory_only', port,
    persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'],
  });
  const url = `postgresql://postgres:synthetic_memory_only@127.0.0.1:${port}/nv_memory_test`;
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('nv_memory_test');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync(join(root, 'prisma/schema.prisma'), 'utf8').replace('Unsupported("vector(1536)")', 'Bytes'));
  const push = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema], {
    // Prisma CLI must not discover the repository .env; the schema and working
    // directory are both isolated, with every database override pointing locally.
    cwd: directory, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, MIGRATION_DATABASE_URL: url }, encoding: 'utf8',
  });
  if (push.status !== 0) throw new Error(`prisma db push failed: ${push.stderr || push.stdout}`);
  const db = new PrismaClient({ datasourceUrl: url, log: [] });

  const vectorDb = new PGlite({ extensions: { vector } });
  await vectorDb.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE "Message" ("id" TEXT PRIMARY KEY, "characterId" TEXT NOT NULL, "userId" TEXT NOT NULL,
      "role" TEXT NOT NULL, "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE "MessageEmbedding" ("id" TEXT PRIMARY KEY, "messageId" TEXT NOT NULL UNIQUE,
      "embedding" vector(1536) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL);
  `);
  const runTagged = (strings, values) => {
    const { text, values: params } = sqlFromTemplate(strings, values);
    return vectorDb.query(text, params);
  };
  const vectorPrisma = {
    messageEmbedding: {
      findUnique: async ({ where }) => (await vectorDb.query('SELECT "id" FROM "MessageEmbedding" WHERE "messageId" = $1', [where.messageId])).rows[0] ?? null,
      deleteMany: async ({ where }) => {
        const ids = where?.messageId?.in ?? (where?.messageId ? [where.messageId] : []);
        if (ids.length === 0) return { count: 0 };
        const result = await vectorDb.query('DELETE FROM "MessageEmbedding" WHERE "messageId" = ANY($1)', [ids]);
        return { count: result.affectedRows ?? 0 };
      },
    },
    $queryRaw: async (strings, ...values) => (await runTagged(strings, values)).rows,
    $executeRaw: async (strings, ...values) => {
      // Mirror the current source row before executing vector SQL, without wrapping
      // message.create/update: transaction arrays must retain their PrismaPromise.
      const sql = strings.join('');
      const messageId = sql.includes('SELECT gen_random_uuid()') ? values[1] : values[0];
      if (typeof messageId === 'string') {
        const row = await db.message.findUnique({ where: { id: messageId } });
        if (row) await mirrorMessages([row], { embed: false });
      }
      return (await runTagged(strings, values)).affectedRows ?? 0;
    },
  };

  const provider = createFakeProvider();
  const liveKey = process.env.KODIKROUTER_API_KEY;
  if (realProvider) {
    if (!liveKey) throw new Error('Live evaluation needs KODIKROUTER_API_KEY in the process environment');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (String(url) === 'https://api.kodikrouter.ru/v1/chat/completions') {
        provider.chatRequests.push({ body: JSON.parse(String(init.body)), at: performance.now() });
      }
      return originalFetch(url, init);
    };
  } else {
    const axios = require('axios');
    axios.post = (url, body) => provider.axiosPost(url, body);
    globalThis.fetch = (url, init) => provider.fetch(url, init);
  }

  const session = { userId: null };
  for (const key of Object.keys(process.env)) {
    if (/^(LOGTAIL_|AI_COST_|KODIK_COST_|ENABLE_RAG_EMBEDDINGS$|MEMORY_DEDUP_THRESHOLD$|DEBUG$)/.test(key)) delete process.env[key];
  }
  process.env.KODIKROUTER_API_KEY = realProvider ? liveKey : 'synthetic_memory_key';
  process.env.NEXTAUTH_SECRET = 'synthetic_memory_actor';
  process.env.DATABASE_URL = url;

  const observedWrites = { summaries: 0 };
  const observedDb = new Proxy(db, { get(target, key) {
    if (key === 'memory') return new Proxy(target.memory, { get(delegate, operation) {
      const value = delegate[operation];
      if (!['create', 'upsert', 'updateMany'].includes(operation)) return value;
      return async (...args) => {
        const result = await value.apply(delegate, args);
        if (operation !== 'updateMany' || result.count > 0) observedWrites.summaries += 1;
        return result;
      };
    } });
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const { load } = createModuleLoader({
    prismaFor: (file) => (file.endsWith('messageEmbeddings.ts') ? vectorPrisma : observedDb),
    session,
    sourceRef,
    sourceTransform,
  });

  const tiktoken = require('tiktoken');
  const encoder = tiktoken.encoding_for_model('gpt-4');
  const countTokens = (text) => encoder.encode(String(text)).length;

  async function settle(timeoutMs = 10_000) {
    const started = Date.now();
    let previous = '';
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      await new Promise((done) => setTimeout(done, 60));
      const snapshot = [provider.total, provider.inflight, await db.aiCostEvent.count(), await db.episodicMemory.count(),
        await db.coreMemory.count(), await db.memory.count(), (await vectorDb.query('SELECT COUNT(*)::int AS c FROM "MessageEmbedding"')).rows[0].c].join(':');
      if (snapshot === previous && provider.inflight === 0) stable += 1;
      else stable = 0;
      previous = snapshot;
      if (stable >= 4) return;
    }
    throw new Error('Background work did not settle');
  }

  async function mirrorMessages(rows, { embed = true } = {}) {
    for (const row of rows) {
      await vectorDb.query('INSERT INTO "Message" VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "createdAt" = EXCLUDED."createdAt"',
        [row.id, row.characterId, row.userId, row.role, row.content, row.createdAt]);
      if (embed) {
        await vectorDb.query('INSERT INTO "MessageEmbedding" VALUES ($1, $2, $3::vector, $4) ON CONFLICT ("messageId") DO NOTHING',
          [`emb_${row.id}`, row.id, `[${fakeEmbedding(row.content).join(',')}]`, row.createdAt]);
      }
    }
  }

  let seq = 0;
  const helpers = {
    async model(maxContextTokens = 16_000) {
      return db.model.upsert({
        where: { name: 'google/gemma-4-31b-it' },
        update: { maxContextTokens, isActive: true },
        create: { name: 'google/gemma-4-31b-it', displayName: 'Gemma 4 31B', priceVC: 4, maxContextTokens, pricePer1MInput: 1, pricePer1MOutput: 1 },
      });
    },
    async user(plan = 'start') {
      seq += 1;
      return db.user.create({
        data: {
          email: `memory-${label}-${seq}@example.test`, verseCoins: 10_000,
          subscriptionType: plan, subscriptionEnd: plan === 'start' ? null : new Date(Date.now() + 30 * 86_400_000),
        },
      });
    },
    async character(ownerId, name = 'Хранитель маяка') {
      seq += 1;
      return db.character.create({ data: { name: `${name} ${seq}`, userId: ownerId, isPublic: true, systemPrompt: `Ты — ${name}. Отвечай коротко.` } });
    },
    async messages(userId, characterId, items, { start = Date.now() - 3_600_000, stepMs = 1000, mirror = true, embed = true } = {}) {
      const rows = items.map((item, index) => ({
        id: `msg_${label}_${++seq}`, userId, characterId, chatId: characterId,
        role: item.role, content: item.content,
        createdAt: item.createdAt ?? new Date(start + index * stepMs),
      }));
      await db.message.createMany({ data: rows });
      if (mirror) await mirrorMessages(rows, { embed });
      return rows;
    },
  };

  async function chat(userId, characterId, body, locale = 'ru') {
    const { NextRequest } = require('next/server');
    const route = load(join(root, 'src/app/api/chat/[id]/route.ts'));
    session.userId = userId;
    const costBefore = new Set((await db.aiCostEvent.findMany({ select: { id: true } })).map((row) => row.id));
    const callsBefore = provider.calls.length;
    const chatRequestsBefore = provider.chatRequests.length;
    const started = performance.now();
    const request = new NextRequest(`http://localhost/api/chat/${characterId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-locale': locale }, body: JSON.stringify(body),
    });
    const response = await route.POST(request, { params: Promise.resolve({ id: characterId }) });
    const text = await response.text();
    const finished = performance.now();
    await settle();
    const events = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const chatRequest = provider.chatRequests[chatRequestsBefore] ?? null;
    const messages = chatRequest?.body?.messages ?? [];
    if (response.status !== 200 || !events.some((event) => event.type === 'end') || messages.length === 0) {
      throw new Error(`Memory scenario did not complete a chat: HTTP ${response.status}, end=${events.some((event) => event.type === 'end')}, providerRequests=${messages.length > 0 ? 1 : 0}`);
    }
    const costRows = (await db.aiCostEvent.findMany({ select: {
      id: true, purpose: true, outcome: true, estimatedCostRub: true, reportedCostRub: true,
      inputTokens: true, outputTokens: true, chargedVC: true, costSource: true,
    } })).filter((row) => !costBefore.has(row.id));
    const costByPurpose = {};
    for (const row of costRows) costByPurpose[row.purpose] = (costByPurpose[row.purpose] ?? 0) + 1;
    const costMetrics = {
      source: realProvider ? 'live-provider' : 'synthetic-provider-not-real-ruble-cost',
      events: costRows.length,
      failedAttempts: costRows.filter((row) => row.outcome === 'failed').length,
      inputTokens: costRows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: costRows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      recordedVC: costRows.reduce((sum, row) => sum + row.chargedVC, 0),
      knownEstimatedRub: costRows.reduce((sum, row) => sum + (row.estimatedCostRub ?? 0), 0),
      unknownCosts: costRows.filter((row) => row.estimatedCostRub === null && row.reportedCostRub === null).length,
    };
    return {
      status: response.status,
      events,
      messages,
      system: String(messages[0]?.content ?? ''),
      promptTokens: messages.reduce((sum, m) => sum + countTokens(m.content), 0),
      systemTokens: countTokens(messages[0]?.content ?? ''),
      prepMs: chatRequest ? chatRequest.at - started : null,
      totalMs: finished - started,
      providerCalls: provider.calls.slice(callsBefore),
      costByPurpose,
      costMetrics,
    };
  }

  async function stop() {
    encoder.free();
    await db.$disconnect().catch(() => {});
    await vectorDb.close().catch(() => {});
    if (process.platform === 'win32' && pg.process) {
      // embedded-postgres taskkill can leave inherited stdio alive on Windows.
      // Stop only this fixture's verified cluster and await its closed pipes.
      const child = pg.process;
      const dataArg = child.spawnargs.indexOf('-D');
      if (dataArg < 0 || resolve(child.spawnargs[dataArg + 1]) !== resolve(join(directory, 'db'))) {
        throw new Error('Refusing to stop an unrelated PostgreSQL cluster');
      }
      const closed = new Promise(done => child.once('close', done));
      const stopped = spawnSync(join(dirname(child.spawnfile), 'pg_ctl.exe'),
        ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w', '-t', '15'],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      if (stopped.status !== 0) throw new Error('Fixture PostgreSQL shutdown failed');
      await closed;
      pg.process = undefined;
    } else await pg.stop();
  }

  return { root, databaseUrl: url, db, vectorDb, provider, session, load, helpers, chat, settle, countTokens, mirrorMessages, stop, observedWrites };
}
