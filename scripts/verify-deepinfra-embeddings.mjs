// Actual client/accounting/vector SQL + exact migration on disposable PGlite. No .env or real API.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
const require = createRequire(import.meta.url);
for (const key of Object.keys(process.env)) if (/^(CHAT_AI_PROVIDER$|MEMORY_AI_PROVIDER$|EMBEDDING_AI_PROVIDER$|DEEPINFRA_|LOGTAIL_|AI_COST_|ENABLE_RAG_EMBEDDINGS$)/.test(key)) delete process.env[key];
process.env.LOGTAIL_SOURCE_TOKEN = ''; process.env.LOGTAIL_INGESTING_HOST = '';
process.env.NEXTAUTH_SECRET = 'synthetic_embedding_actor';
process.env.DEEPINFRA_API_KEY = 'synthetic_di_key'; process.env.DEEPINFRA_USD_RUB = '108.192';
const pg = new PGlite({ extensions: { vector } });
let checks = 0;
async function check(label, fn) { await fn(); checks++; console.log(`PASS ${label}`); }
const events = new Map(), posts = [];
const tagged = async (strings, values) => {
  let sql = ''; strings.forEach((part, i) => { sql += part + (i < values.length ? `$${i + 1}` : ''); });
  return pg.query(sql, values);
};
const eligibleSql = (where) => {
  assert.deepEqual(where.role.in, ['user', 'assistant']); assert.equal(where.deepinfraEmbedding, null);
  return `m.role IN ('user','assistant') AND m.content <> '' AND e.id IS NULL${where.user ? " AND u.\"subscriptionType\" IN ('dialog','history','story','universe') AND u.\"subscriptionEnd\" > NOW()" : ''}`;
};
const prisma = {
  model: { findUnique: async () => null },
  aiCostEvent: {
    create: async ({ data }) => { events.set(data.id, { ...data }); return data; },
    update: async ({ where, data }) => { Object.assign(events.get(where.id), data); return events.get(where.id); },
  },
  messageEmbedding: { findUnique: async ({ where }) => (await pg.query('SELECT id FROM "MessageEmbedding" WHERE "messageId"=$1', [where.messageId])).rows[0] },
  messageEmbeddingDeepinfra: {
    findUnique: async ({ where }) => (await pg.query('SELECT id FROM "MessageEmbeddingDeepinfra" WHERE "messageId"=$1', [where.messageId])).rows[0],
    count: async () => Number((await pg.query('SELECT COUNT(*) AS n FROM "MessageEmbeddingDeepinfra"')).rows[0].n),
  },
  message: {
    count: async ({ where }) => Number((await pg.query(`SELECT COUNT(*) AS n FROM "Message" m JOIN "User" u ON u.id=m."userId" LEFT JOIN "MessageEmbeddingDeepinfra" e ON e."messageId"=m.id WHERE ${eligibleSql(where)}`)).rows[0].n),
    findMany: async ({ where, take, orderBy }) => {
      assert.equal(take, 10); assert.deepEqual(orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
      return (await pg.query(`SELECT m.id,m.content,m."userId",u."subscriptionType" FROM "Message" m JOIN "User" u ON u.id=m."userId" LEFT JOIN "MessageEmbeddingDeepinfra" e ON e."messageId"=m.id WHERE ${eligibleSql(where)} ORDER BY m."createdAt" DESC,m.id DESC LIMIT $1`, [take])).rows.map(r => ({ ...r, user: { subscriptionType: r.subscriptionType } }));
    },
  },
  embeddingBackfillLease: {
    deleteMany: async ({ where }) => ({ count: (await pg.query('DELETE FROM "EmbeddingBackfillLease" WHERE id=$1 AND owner=$2', [where.id, where.owner])).affectedRows }),
  },
  $queryRaw: async (strings, ...values) => (await tagged(strings, values)).rows,
  $executeRaw: async (strings, ...values) => (await tagged(strings, values)).affectedRows,
};
const { root, load } = createModuleLoader({ prismaFor: () => prisma });
const config = load(join(root, 'src/lib/embeddingProviders.ts'));
const client = load(join(root, 'src/lib/embeddingClient.ts'));
const memory = load(join(root, 'src/lib/memoryEmbeddings.ts'));
const rag = load(join(root, 'src/lib/messageEmbeddings.ts'));
const backfill = load(join(root, 'src/lib/embeddingBackfill.ts'));
let mutate = null, before = null, failure = false, estimatedCost = undefined;
const makeVector = (dims, axis = 0) => Array.from({ length: dims }, (_, i) => i === axis ? 1 : 0);
const axios = require('axios');
axios.post = async (url, body, options) => {
  if (!['https://api.deepinfra.com/v1/openai/embeddings','https://api.kodikrouter.ru/v1/embeddings'].includes(url)) throw new Error('External network forbidden');
  posts.push({ url, body, options });
  if (before) await before(options);
  if (failure) throw Object.assign(new Error('synthetic failure'), { isAxiosError: true, response: { status: 503, headers: {}, data: {} } });
  const dimensions = body.model === config.DEEPINFRA_EMBEDDING_MODEL ? 1024 : 1536;
  const response = { model: body.model, usage: { prompt_tokens: 100, total_tokens: 100, estimated_cost: estimatedCost },
    data: body.input.map((_, index) => ({ index, embedding: makeVector(dimensions, index % 2) })) };
  if (mutate) mutate(response);
  return { status: 200, headers: { 'x-request-id': 'di_embedding_fixture' }, data: response };
};
const latestEvent = () => [...events.values()].at(-1);
const scope = { userId: 'owner', characterId: 'card', threadId: 'story-fixture', legacy: true };
const settle = async () => { await new Promise(r => setTimeout(r, 60)); };
const insertMessage = async (id, userId = 'owner', characterId = 'card', content = 'Ключ лежит под ступенью.', role = 'user') => {
  await pg.query('INSERT INTO "Message" (id,"userId","characterId",content,role,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())', [id, userId, characterId, content, role]);
};
try {
  await pg.exec(`CREATE EXTENSION vector;
    CREATE TABLE "User" (id text PRIMARY KEY,"subscriptionType" text,"subscriptionEnd" timestamp);
    CREATE TABLE "Message" (id text PRIMARY KEY,"userId" text,"characterId" text,"threadId" text,content text,role text,"createdAt" timestamp);
    CREATE TABLE "MessageEmbedding" (id text PRIMARY KEY,"messageId" text UNIQUE REFERENCES "Message"(id) ON DELETE CASCADE,embedding vector(1536),"createdAt" timestamp);
    INSERT INTO "User" VALUES ('owner','universe',NOW()+INTERVAL '1 day'),('outsider','universe',NOW()+INTERVAL '1 day'),('expired','universe',NOW()-INTERVAL '1 day'),('free','start',NULL);`);
  await insertMessage('legacy');
  await pg.query('INSERT INTO "MessageEmbedding" VALUES ($1,$2,$3::vector,NOW())', ['old-vector', 'legacy', `[${makeVector(1536)}]`]);
  const migration = readFileSync(join(root, 'prisma/migrations/20261011230000_deepinfra_embeddings/migration.sql'), 'utf8');
  await pg.exec(`BEGIN; ${migration} COMMIT;`);
  await check('exact migration preserves legacy vectors and message content', async () => {
    assert.equal((await pg.query('SELECT id FROM "MessageEmbedding"')).rows[0].id, 'old-vector');
    assert.equal((await pg.query('SELECT content FROM "Message" WHERE id=$1', ['legacy'])).rows[0].content, 'Ключ лежит под ступенью.');
  });
  await check('new store has 1024 dimensions, unique key, HNSW and cascading FK', async () => {
    assert.equal((await pg.query("SELECT format_type(atttypid,atttypmod) AS t FROM pg_attribute WHERE attrelid='\"MessageEmbeddingDeepinfra\"'::regclass AND attname='embedding'")).rows[0].t, 'vector(1024)');
    const indexes = (await pg.query('SELECT indexdef FROM pg_indexes WHERE tablename=$1', ['MessageEmbeddingDeepinfra'])).rows;
    assert.ok(indexes.some(r => r.indexdef.includes('UNIQUE') && r.indexdef.includes('messageId')));
    assert.ok(indexes.some(r => r.indexdef.includes('hnsw')));
    assert.equal((await pg.query("SELECT confdeltype FROM pg_constraint WHERE conname='MessageEmbeddingDeepinfra_messageId_fkey'")).rows[0].confdeltype, 'c');
  });
  await check('default preserves Kodik until memory switch', async () => { assert.equal(config.getEmbeddingProvider(), 'kodikrouter'); });
  process.env.MEMORY_AI_PROVIDER = 'deepinfra';
  await check('embedding routing follows memory switch', async () => { assert.equal(config.getEmbeddingProvider(), 'deepinfra'); });
  await check('dedup uses DeepInfra key, model, 1024 dimensions and no retrieval instruction', async () => {
    const vectors = await memory.fetchEmbeddings(['Факт один', 'Факт два'], 'wrong_legacy_key');
    assert.equal(vectors.length, 2); assert.equal(vectors[0].length, 1024);
    const post = posts.at(-1); assert.equal(post.url, config.DEEPINFRA_EMBEDDING_URL);
    assert.equal(post.options.headers.Authorization, 'Bearer synthetic_di_key'); assert.deepEqual(post.body.input, ['Факт один', 'Факт два']);
    assert.equal(post.options.maxRedirects, 0); assert.ok(post.options.timeout <= 25000 && post.options.timeout > 20000); assert.ok(post.options.signal);
  });
  await check('embedding accounting uses input tokens, zero output and quoted RUB estimate', async () => {
    const event = latestEvent(); assert.equal(event.provider, 'deepinfra'); assert.equal(event.apiSurface, 'embeddings');
    assert.equal(event.inputTokens, 100); assert.equal(event.outputTokens, 0); assert.equal(event.usageSource, 'provider');
    assert.equal(event.costSource, 'deepinfra_catalog_estimate'); assert.ok(Math.abs(event.estimatedCostRub - .000108192) < 1e-12);
    assert.equal(event.reportedCostRub, null); assert.equal(event.quotedVC, null); assert.equal(event.providerRequestId, 'di_embedding_fixture');
  });
  await check('optional estimated USD cost remains an estimate, never a ledger debit', async () => {
    estimatedCost = .001; await memory.fetchEmbeddings(['Факт'], ''); estimatedCost = undefined;
    assert.equal(latestEvent().costSource, 'deepinfra_usd_estimate'); assert.equal(latestEvent().providerCostSemantics, 'provider_estimated_usd'); assert.equal(latestEvent().reportedCostRub, null);
  });
  await check('missing funded FX leaves RUB unknown', async () => {
    delete process.env.DEEPINFRA_USD_RUB; await memory.fetchEmbeddings(['Факт'], '');
    assert.equal(latestEvent().estimatedCostRub, null); assert.equal(latestEvent().costSource, 'unknown'); process.env.DEEPINFRA_USD_RUB = '108.192';
  });
  await check('empty batch makes no provider or cost request', async () => { const n = posts.length; assert.deepEqual(await memory.fetchEmbeddings([], ''), []); assert.equal(posts.length, n); });
  await check('unsorted response indices are restored without losing rows', async () => {
    mutate = response => response.data.reverse(); const result = await memory.fetchEmbeddings(['a', 'b'], ''); mutate = null;
    assert.equal(result[0][0], 1); assert.equal(result[1][1], 1);
  });
  for (const [label, transform] of [
    ['duplicate index', r => r.data[1].index = 0], ['wrong dimension', r => r.data[0].embedding.pop()],
    ['non-finite number', r => r.data[0].embedding[0] = NaN], ['zero vector', r => r.data[0].embedding.fill(0)],
    ['wrong model', r => r.model = 'different/model'], ['missing row', r => r.data.pop()],
  ]) await check(`malformed response rejected: ${label}`, async () => {
    mutate = transform; await assert.rejects(memory.fetchEmbeddings(['a', 'b'], '')); mutate = null;
  });
  await check('large batches are split at 32 and preserve total row order', async () => {
    const n = posts.length; assert.equal((await memory.fetchEmbeddings(Array.from({ length: 35 }, (_, i) => `text ${i}`), '')).length, 35);
    assert.deepEqual(posts.slice(n).map(p => p.body.input.length), [32, 3]);
  });
  await check('total batch deadline does not restart for the next chunk', async () => {
    before = async () => { await new Promise(r => setTimeout(r, 35)); };
    await assert.rejects(client.fetchTextEmbeddings(Array(35).fill('text'), '', 'dedup', 20)); before = null;
  });
  await check('real abort signal bounds a stalled transport and records a failed attempt', async () => {
    before = options => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('test watchdog')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('synthetic abort')); }, { once: true });
    });
    await assert.rejects(client.fetchTextEmbeddings(['text'], '', 'document', 25)); before = null;
    assert.equal(latestEvent().outcome, 'failed');
  });
  await check('RAG query has an instruction, document does not; query wait <=5 seconds', async () => {
    const n = posts.length;
    await rag.searchRelevantMessages(scope, 'Где ключ?', '');
    assert.match(posts.at(-1).body.input[0], /^Instruct: /); assert.ok(posts.at(-1).options.timeout <= 5000 && posts.at(-1).options.timeout > 4500);
    assert.equal(posts.length - n, 1, 'a fast answer sends no hedge');
    assert.equal(await rag.saveMessageEmbeddingFromContent('legacy', 'Ключ лежит под ступенью.', ''), true);
    assert.deepEqual(posts.at(-1).body.input, ['Ключ лежит под ступенью.']);
  });
  const rateLimited = (headers = {}) => Object.assign(new Error('synthetic 429'), { isAxiosError: true, response: { status: 429, headers, data: {} } });
  const limitFirst = (count, headers) => { let seen = 0; before = async () => { if (seen++ < count) throw rateLimited(headers); }; };
  await check('one 429 is retried once inside the RAG budget and both attempts are accounted', async () => {
    const n = posts.length, e = events.size; limitFirst(1);
    const started = Date.now(); const result = await client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 3000); before = null;
    assert.equal(result.vectors.length, 1); assert.equal(posts.length - n, 2); assert.ok(Date.now() - started >= 250);
    assert.ok(posts.at(-1).options.timeout < 3000 - 200); assert.match(posts.at(-1).body.input[0], /^Instruct: /);
    assert.deepEqual([...events.values()].slice(e).map(row => row.outcome), ['failed', 'completed']);
  });
  await check('a second 429 is not retried again', async () => {
    const n = posts.length; limitFirst(2);
    await assert.rejects(client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 3000), { message: 'synthetic 429' }); before = null;
    assert.equal(posts.length - n, 2);
  });
  await check('429 is not retried when the remaining budget or Retry-After cannot fit', async () => {
    let n = posts.length; limitFirst(1);
    await assert.rejects(client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 600), { message: 'synthetic 429' }); before = null;
    assert.equal(posts.length - n, 1);
    n = posts.length; limitFirst(1, { 'retry-after': '5' });
    await assert.rejects(client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 3000), { message: 'synthetic 429' }); before = null;
    assert.equal(posts.length - n, 1);
  });
  // Per-call behaviour: 'stall' waits for its abort signal, a number answers after that many ms.
  const scripted = (plan) => { let call = 0; before = options => {
    const step = plan[Math.min(call++, plan.length - 1)];
    if (step === 'stall') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true }));
    return new Promise(resolve => setTimeout(resolve, step));
  }; };
  await check('a slow RAG query gets one hedge; the first answer wins and the loser is recorded as cancelled', async () => {
    const n = posts.length, e = events.size; scripted(['stall', 10]);
    const started = Date.now(); const result = await client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 5000); before = null;
    const elapsed = Date.now() - started; await settle();
    assert.equal(result.vectors.length, 1); assert.equal(posts.length - n, 2);
    assert.ok(elapsed >= client.QUERY_HEDGE_DELAY_MS && elapsed < client.QUERY_HEDGE_DELAY_MS + 1000, `hedge answered in ${elapsed} ms`);
    assert.deepEqual(posts.slice(n).map(post => post.body.input), [posts[n].body.input, posts[n].body.input]);
    assert.deepEqual([...events.values()].slice(e).map(row => row.outcome), ['cancelled', 'completed']);
  });
  await check('background embeddings are never hedged', async () => {
    const n = posts.length; scripted([client.QUERY_HEDGE_DELAY_MS + 300]);
    await client.fetchTextEmbeddings(['Ключ лежит под ступенью.'], '', 'document', 5000); before = null;
    assert.equal(posts.length - n, 1);
  });
  await check('when both attempts stall the query fails at its deadline as an ordinary failure', async () => {
    const n = posts.length, e = events.size; scripted(['stall']);
    const started = Date.now();
    await assert.rejects(client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 2600)); before = null;
    const elapsed = Date.now() - started; await settle();
    assert.equal(posts.length - n, 2); assert.ok(elapsed >= 2500 && elapsed < 3200, `failed after ${elapsed} ms`);
    assert.deepEqual([...events.values()].slice(e).map(row => row.outcome), ['failed', 'failed']);
  });
  await check('no hedge is sent when the remaining budget is too short to help', async () => {
    const n = posts.length; scripted(['stall']);
    await assert.rejects(client.fetchTextEmbeddings(['Где ключ?'], '', 'query', 1900)); before = null;
    assert.equal(posts.length - n, 1);
  });
  await check('legacy vectors are retained; completed new vectors are not requested twice', async () => {
    const n = posts.length; assert.equal(await rag.saveMessageEmbeddingFromContent('legacy', 'Ключ лежит под ступенью.', ''), false);
    assert.equal(posts.length, n); assert.equal((await pg.query('SELECT COUNT(*) AS n FROM "MessageEmbedding"')).rows[0].n, 1);
  });
  await insertMessage('other-user', 'outsider'); await insertMessage('other-card', 'owner', 'elsewhere'); await insertMessage('only-old', 'owner', 'card', 'OLD_SPACE_ONLY');
  await rag.saveMessageEmbeddingFromContent('other-user', 'Ключ лежит под ступенью.', ''); await rag.saveMessageEmbeddingFromContent('other-card', 'Ключ лежит под ступенью.', '');
  await pg.query('INSERT INTO "MessageEmbedding" VALUES ($1,$2,$3::vector,NOW())', ['old-only-vector','only-old',`[${makeVector(1536)}]`]);
  await check('retrieval never mixes spaces, users or characters; excluded IDs stay excluded', async () => {
    const rows = await rag.searchRelevantMessages(scope, 'Где ключ?', '', undefined, 5, .25, { excludedMessageIds: ['only-old'] });
    assert.ok(rows.some(r => r.id === 'legacy')); assert.ok(rows.every(r => !['other-user','other-card','only-old'].includes(r.id)));
    assert.deepEqual(await rag.searchRelevantMessages(scope, 'Где ключ?', '', 'legacy', 5, .25), []);
  });
  await check('provider failure falls back without calling Kodik', async () => {
    failure = true; assert.deepEqual(await rag.searchRelevantMessages(scope,'Где ключ?',''), []);
    assert.equal(await memory.isSemanticDuplicate('Факт',['Другой факт'],''), null); failure = false;
    assert.ok(posts.every(p => p.url === config.DEEPINFRA_EMBEDDING_URL));
  });
  await check('late response cannot save a vector for rewritten source content', async () => {
    await insertMessage('rewritten'); before = async () => { await pg.query('UPDATE "Message" SET content=$1 WHERE id=$2', ['Новый текст','rewritten']); };
    assert.equal(await rag.saveMessageEmbeddingFromContent('rewritten','Ключ лежит под ступенью.',''), false); before = null;
    assert.equal(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'rewritten' } }), undefined);
  });
  await check('refresh invalidates both vector spaces, then only embeds selected provider', async () => {
    await pg.query('UPDATE "Message" SET content=$1 WHERE id=$2', ['Ключ перенесён в кладовую.','legacy']);
    const n = posts.length; rag.scheduleMessageEmbeddingRefresh('legacy','Ключ перенесён в кладовую.','',true); await settle();
    assert.equal(posts.length, n + 1); assert.equal(await prisma.messageEmbedding.findUnique({ where: { messageId: 'legacy' } }), undefined);
    assert.ok(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'legacy' } }));
  });
  await check('stale refresh cannot remove the current vector', async () => {
    rag.scheduleMessageEmbeddingRefresh('legacy','Ключ лежит под ступенью.','',false); await settle();
    assert.ok(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'legacy' } }));
  });
  await check('deleting a message removes its new vector through the FK', async () => {
    await pg.query('DELETE FROM "Message" WHERE id=$1', ['other-user']); assert.equal(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'other-user' } }), undefined);
  });
  for (let i = 0; i < 14; i++) await insertMessage(`backfill-${i}`);
  await insertMessage('expired-message','expired'); await insertMessage('free-message','free'); await insertMessage('system-message','owner','card','SYSTEM_NOTE','system');
  await check('backfill status is read-only and respects active subscriptions', async () => {
    const n = posts.length; const status = await backfill.embeddingBackfillStatus(); assert.equal(status.remaining, 16); assert.equal(posts.length, n);
  });
  await check('parallel workers use one lease and spend at most ten requests', async () => {
    const n = posts.length; const results = await Promise.all([backfill.backfillDeepinfraEmbeddings(),backfill.backfillDeepinfraEmbeddings()]);
    assert.equal(results.filter(r => r.busy).length, 1); const active = results.find(r => !r.busy);
    assert.equal(active.attempted, 10); assert.equal(active.saved, 10); assert.equal(posts.length-n, 10);
    assert.ok(latestEvent().actorHash); assert.equal(latestEvent().subscriptionType, 'universe');
    assert.equal(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'expired-message' } }), undefined);
    assert.equal(await prisma.messageEmbeddingDeepinfra.findUnique({ where: { messageId: 'free-message' } }), undefined);
  });
  await check('backfill advances without replacing already completed vectors', async () => {
    assert.equal((await backfill.backfillDeepinfraEmbeddings()).saved, 6); assert.equal((await backfill.embeddingBackfillStatus()).remaining, 0);
  });
  await insertMessage('retry-message');
  await check('first provider failure stops backfill and retains a retry cooldown', async () => {
    failure = true; const n = posts.length; const result = await backfill.backfillDeepinfraEmbeddings(); failure = false;
    assert.equal(result.failed, 1); assert.equal(posts.length-n, 1); assert.equal((await backfill.backfillDeepinfraEmbeddings()).busy, true);
    await pg.exec('UPDATE "EmbeddingBackfillLease" SET "leaseUntil"=(NOW() AT TIME ZONE \'UTC\')-INTERVAL \'1 second\'');
    assert.equal((await backfill.backfillDeepinfraEmbeddings()).saved, 1);
  });
  await check('disabled provider makes no API calls for dedup, RAG or scheduled persistence', async () => {
    process.env.EMBEDDING_AI_PROVIDER = 'disabled'; const n = posts.length;
    assert.equal(await memory.isSemanticDuplicate('Факт',['Другой факт'],''), null);
    assert.deepEqual(await rag.searchRelevantMessages(scope,'Где ключ?',''), []);
    rag.scheduleMessageEmbedding('retry-message','text','',true); await settle(); assert.equal(posts.length, n);
    await assert.rejects(backfill.backfillDeepinfraEmbeddings());
  });
  await check('invalid provider and missing key fail before network', async () => {
    const n = posts.length; process.env.EMBEDDING_AI_PROVIDER = 'unknown'; await assert.rejects(memory.fetchEmbeddings(['text'],''));
    process.env.EMBEDDING_AI_PROVIDER = 'deepinfra'; delete process.env.DEEPINFRA_API_KEY; await assert.rejects(memory.fetchEmbeddings(['text'],''));
    assert.equal(posts.length, n); process.env.DEEPINFRA_API_KEY = 'synthetic_di_key';
  });
  await check('explicit Kodik rollback uses its own model/key/1536 dimensions', async () => {
    process.env.EMBEDDING_AI_PROVIDER = 'kodikrouter'; const vectors = await memory.fetchEmbeddings(['text'],'synthetic_legacy_key');
    assert.equal(vectors[0].length,1536); assert.equal(posts.at(-1).options.headers.Authorization,'Bearer synthetic_legacy_key');
    assert.equal(posts.at(-1).body.model,'openai/text-embedding-3-small');
  });
  const route = load(join(root, 'src/app/api/cron/backfill-embeddings/route.ts'));
  const { NextRequest } = require('next/server');
  process.env.EMBEDDING_AI_PROVIDER = 'deepinfra'; process.env.CRON_SECRET = 'synthetic_cron_only';
  await check('real cron handlers reject missing and wrong secret without spending', async () => {
    const n = posts.length;
    for (const method of ['GET','POST']) {
      const response = await route[method](new NextRequest('https://example.test/api/cron/backfill-embeddings?secret=wrong', { method }));
      assert.equal(response.status,401); assert.doesNotMatch(await response.text(), /synthetic_cron_only/);
    }
    delete process.env.CRON_SECRET; assert.equal((await route.POST(new NextRequest('https://example.test/api/cron/backfill-embeddings', { method:'POST' }))).status,401);
    assert.equal(posts.length,n); process.env.CRON_SECRET = 'synthetic_cron_only';
  });
  await check('authorized GET remains read-only and POST advances the real backfill', async () => {
    await insertMessage('cron-new'); const n = posts.length;
    const headers = { 'x-cron-secret':'synthetic_cron_only' };
    const status = await route.GET(new NextRequest('https://example.test/api/cron/backfill-embeddings', { headers }));
    assert.equal(status.status,200); assert.equal((await status.json()).remaining,1); assert.equal(posts.length,n);
    const response = await route.POST(new NextRequest('https://example.test/api/cron/backfill-embeddings', { method:'POST',headers }));
    assert.equal(response.status,200); assert.equal((await response.json()).saved,1); assert.equal(posts.length,n+1);
  });
  await check('provider failure returns HTTP 503 with counters, no provider body or secret', async () => {
    await insertMessage('cron-failure'); failure = true;
    const response = await route.POST(new NextRequest('https://example.test/api/cron/backfill-embeddings', {
      method:'POST', headers:{ 'x-cron-secret':'synthetic_cron_only' },
    })); failure = false;
    assert.equal(response.status,503); const result = await response.json(); assert.equal(result.ok,false); assert.equal(result.failed,1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|Ключ|Bearer|apiKey/);
  });
  console.log(`verify:deepinfra:embeddings: ${checks} passed`);
} finally { await pg.close(); }
