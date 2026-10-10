// Disposable SQL database, real request builders and rendered picker. No live AI or .env.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest, NextResponse } from 'next/server.js';

function load(file, dependencies = {}) {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => dependencies[name] ?? {}, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const previousCatalog = JSON.parse(readFileSync('src/lib/data/testing-chat-models-2026-10-10.json', 'utf8'));
const catalog = JSON.parse(readFileSync('src/lib/data/testing-roleplay-models-2026-10-10.json', 'utf8'));
const policy = load('src/lib/testingChatModels.ts', {
  './data/testing-chat-models-2026-10-10.json': previousCatalog,
  './data/testing-roleplay-models-2026-10-10.json': catalog,
});
assert.equal(catalog.length, 8);
assert.equal(new Set(catalog.map(model => model.name)).size, 8);
const expectedVC = [9, 7, 11, 16, 24, 24, 28, 38];
assert.deepEqual(catalog.map(model => model.priceVC), expectedVC);
assert.deepEqual(policy.chatModelGenerationOptions('existing-model'), { max_tokens: 1000, temperature: 0.7 });
assert.equal(policy.chatModelRequestTimeoutMs('existing-model'), 30000);
assert.equal(policy.chatModelGenerationOptions(catalog[5].name).reasoning.effort, 'none');
assert.equal(policy.chatModelGenerationOptions(catalog[5].name).reasoning.enabled, false);
assert.equal(policy.chatModelGenerationOptions(catalog[7].name).reasoning.effort, 'low');
assert.equal(policy.chatModelGenerationOptions(catalog[7].name).max_tokens, 4000);
for (const index of [0, 1, 2, 3, 4, 6]) assert.equal(policy.chatModelGenerationOptions(catalog[index].name).reasoning, undefined);
assert.equal(policy.RETIRED_TESTING_CHAT_MODEL_NAMES.length, 4);
assert.ok(!policy.isRetiredChatModel(catalog[7].name));
const providerSnapshot = JSON.parse(readFileSync('docs/chat-roleplay-provider-snapshot-2026-10-10.json', 'utf8'));
for (const model of catalog) {
  const provider = providerSnapshot.models.find(row => row.id === model.name);
  assert.ok(provider.context_length >= model.maxContextTokens);
  assert.equal(model.pricePer1MInput, Math.round(provider.input_price_per_1m * 96.7 * 100) / 100);
  assert.equal(model.pricePer1MOutput, Math.round(provider.output_price_per_1m * 96.7 * 100) / 100);
}
const costMath = load('src/lib/aiCostMath.ts');
const costSnapshot = JSON.parse(readFileSync('src/lib/data/kodik-cost-rates-2026-10-08.json', 'utf8'));
const rates = load('src/lib/kodikCostRates.ts', {
  './data/kodik-cost-rates-2026-10-08.json': costSnapshot,
  './data/kodik-model-aliases.json': {}, './testingChatModels': policy, './aiCostMath': costMath,
});
for (const model of [...catalog, ...previousCatalog]) {
  assert.deepEqual(rates.getKodikCostRates(model.name), costSnapshot.rates[model.name] ?? { input: model.pricePer1MInput, output: model.pricePer1MOutput });
}
assert.deepEqual(rates.getKodikCostRates(catalog[0].name, { pricePer1MInput: 1, pricePer1MOutput: 2 }), { input: 1, output: 2 });

const requests = [];
const economy = load('src/lib/chatEconomy.ts');
let selectedModelFixture;
const baseFixture = { id: 'base', name: 'existing-model', isActive: true, priceVC: 4, maxContextTokens: 20000 };
const helpers = load('src/lib/chatHelpers.ts', {
  '@/lib/testingChatModels': policy,
  '@/lib/verseChatEconomy': economy,
  '@/lib/prisma': { prisma: {
    model: { findFirst: async query => {
      assert.deepEqual(query.where.name.notIn, policy.NON_DEFAULT_CHAT_MODEL_NAMES);
      return baseFixture;
    } },
    user: { findUnique: async () => ({ id: 'synthetic-user', selectedModel: selectedModelFixture }) },
  } },
  '@/lib/subscriptionState': { applyPendingSubscriptionIfDue: async () => null },
  '@/lib/retryWithBackoff': { retryWithBackoff: fn => fn() },
  '@/lib/aiCostTelemetry': {
    meteredPost: async (_purpose, _url, body, config) => { requests.push({ body, timeout: config.timeout }); return { data: { choices: [{ message: { content: 'Synthetic answer' } }] } }; },
    meteredChatFetch: async (_url, init) => { requests.push({ body: JSON.parse(init.body) }); return new Response('synthetic stream'); },
  },
});
for (const model of [...catalog, { name: 'existing-model' }]) {
  const expected = policy.chatModelGenerationOptions(model.name);
  assert.equal(await helpers.callChatCompletion(model.name, [{ role: 'user', content: 'synthetic' }], 'synthetic-key'), 'Synthetic answer');
  const nonstream = requests.at(-1);
  const stream = await helpers.streamChatCompletion(model.name, [{ role: 'user', content: 'synthetic' }], 'synthetic-key');
  await new Response(stream).text();
  const streaming = requests.at(-1);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(nonstream.body[key], value);
    assert.deepEqual(streaming.body[key], value);
  }
  assert.equal(nonstream.timeout, policy.chatModelRequestTimeoutMs(model.name));
  assert.equal(streaming.body.stream_options.include_usage, true);
}
const universe = { subscriptionType: 'universe', subscriptionEnd: new Date(Date.now() + 86400000) };
assert.equal(helpers.resolveContextTokenBudget(universe, { name: catalog[7].name, maxContextTokens: 12000 }), 8000);
assert.equal(helpers.resolveContextTokenBudget(universe, { maxContextTokens: 12000 }), 11000);

// Read the existing seed as data without running its database mutations.
const seed = readFileSync('prisma/seed.js', 'utf8');
const existingCatalog = new Function('return ' + seed.match(/const models = (\[[\s\S]*?\]);/)[1])();
assert.equal(existingCatalog.length, 9);
for (const model of [...existingCatalog, ...catalog]) {
  assert.equal(model.maxContextTokens, 20000);
  for (const [subscriptionType, expected] of [['start', 6000], ['dialog', 6000], ['story', 10000], ['universe', 16000]]) {
    const user = { ...universe, subscriptionType };
    const input = helpers.resolveContextTokenBudget(user, model);
    assert.equal(input, expected, `${subscriptionType}/${model.name}: full plan input`);
    assert.ok(input + policy.chatModelGenerationOptions(model.name).max_tokens <= model.maxContextTokens);
  }
  assert.equal(helpers.resolveContextTokenBudget({ ...universe, subscriptionEnd: new Date(0) }, model), 6000);
  assert.equal(helpers.resolveContextTokenBudget({ subscriptionType: 'start', subscriptionEnd: null }, model), 6000);
}
for (const name of policy.RETIRED_TESTING_CHAT_MODEL_NAMES) {
  selectedModelFixture = { id: 'retired', name, isActive: true, priceVC: 0, maxContextTokens: 20000 };
  assert.equal((await helpers.resolveChatContext('synthetic-user')).model.id, 'base', 'Soft retirement applies before SQL disables the row');
}
selectedModelFixture = { id: 'retained', ...catalog[7], isActive: true };
assert.equal((await helpers.resolveChatContext('synthetic-user')).model.id, 'retained');

// Exercise the actual guest call site's budget expression and model resolver.
const guestAst = ts.createSourceFile('guest.ts', readFileSync('src/lib/anonymousChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let guestTrim;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(guestAst) === 'trimMessagesToTokenLimit') guestTrim = node;
  ts.forEachChild(node, visit);
}
visit(guestAst);
assert.ok(guestTrim, 'Guest handler trims its prompt');
const guestBudget = new Function('resolveContextTokenBudget', 'model', 'return ' + guestTrim.arguments[1].getText(guestAst));
assert.equal(guestBudget(helpers.resolveContextTokenBudget, { name: 'google/gemma-4-31b-it', maxContextTokens: 20000 }), 6000);
assert.equal(guestBudget(helpers.resolveContextTokenBudget, { name: 'google/gemma-4-31b-it', maxContextTokens: 4000 }), 3000);
const guestResolver = guestAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveAnonymousModel');
const guestCode = ts.transpileModule(guestResolver.getText(guestAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const guestQueries = [];
const resolveGuestModel = new Function('prisma', 'NON_DEFAULT_CHAT_MODEL_NAMES', guestCode + '\nreturn resolveAnonymousModel;')({
  model: { findFirst: async query => { guestQueries.push(query); return null; } },
}, policy.NON_DEFAULT_CHAT_MODEL_NAMES);
await resolveGuestModel();
assert.equal(guestQueries.length, 2);
assert.deepEqual(guestQueries[1].where.name.notIn, policy.NON_DEFAULT_CHAT_MODEL_NAMES);

const db = new PGlite();
try {
  const baseline = readFileSync('prisma/migrations/20260801000000_baseline/migration.sql', 'utf8');
  const table = baseline.match(/CREATE TABLE "Model" \([\s\S]*?\);/)[0];
  await db.exec(table + '\nCREATE UNIQUE INDEX "Model_name_key" ON "Model"("name");');
  await db.exec(`INSERT INTO "Model" (id,name,"displayName","priceVC") VALUES ('base','existing-model','Existing',4), ('preserved-id','sao10k/l3.3-euryale-70b','Old experimental',1);
    CREATE TABLE "SyntheticSelection" ("modelId" TEXT REFERENCES "Model"(id));
    INSERT INTO "SyntheticSelection" VALUES ('preserved-id');`);
  const sql = readFileSync('prisma/migrations/20261010190000_chat_testing_models/migration.sql', 'utf8');
  await db.exec(sql); await db.exec(sql);
  for (const [index, model] of existingCatalog.entries()) {
    await db.query('INSERT INTO "Model" (id,name,"displayName","priceVC","maxContextTokens","pricePer1MInput","pricePer1MOutput") VALUES ($1,$2,$3,$4,12000,123.45,678.9)',
      [`old-${index}`, model.name, model.displayName, model.priceVC]);
  }
  await db.exec('INSERT INTO "SyntheticSelection" VALUES (\'old-0\');');
  const before = (await db.query('SELECT * FROM "Model" ORDER BY id')).rows;
  const contextSql = readFileSync('prisma/migrations/20261010200000_chat_context_limits/migration.sql', 'utf8');
  await db.exec(contextSql); await db.exec(contextSql);
  const after = (await db.query('SELECT * FROM "Model" ORDER BY id')).rows;
  const knownNames = new Set([...existingCatalog, ...previousCatalog].map(model => model.name));
  assert.equal(after.filter(model => model.maxContextTokens === 20000).length, 14);
  assert.deepEqual(after, before.map(model => knownNames.has(model.name) ? { ...model, maxContextTokens: 20000 } : model),
    'Context SQL changes only the window for known names, preserving every other field and unknown models');
  assert.deepEqual((await db.query('SELECT "modelId" FROM "SyntheticSelection" ORDER BY "modelId"')).rows,
    [{ modelId: 'old-0' }, { modelId: 'preserved-id' }]);

  const refreshSql = readFileSync('prisma/migrations/20261010220000_roleplay_testing_catalog/migration.sql', 'utf8');
  // The release is one transaction: an error after both statements must undo inserts and retirement.
  await assert.rejects(() => db.exec('BEGIN;\n' + refreshSql + '\nSELECT * FROM "SyntheticMissingTable";\nCOMMIT;'));
  await db.exec('ROLLBACK;');
  assert.deepEqual((await db.query('SELECT * FROM "Model" ORDER BY id')).rows, after);
  await db.exec('BEGIN;\n' + refreshSql + '\nCOMMIT;');
  await db.exec('BEGIN;\n' + refreshSql + '\nCOMMIT;');
  const { rows } = await db.query('SELECT * FROM "Model" ORDER BY "priceVC", "createdAt"');
  assert.equal(rows.length, 22, 'Nine ordinary, eight current testing, four retired, one unknown; SQL adds seven without deleting');
  for (const row of after) {
    const updated = rows.find(model => model.id === row.id);
    if (policy.isRetiredChatModel(row.name)) assert.deepEqual(updated, { ...row, isActive: false });
    else if (!policy.isTestingChatModel(row.name)) assert.deepEqual(updated, row, 'Ordinary and unknown models are untouched');
  }
  assert.equal(rows.find(model => model.name === catalog[7].name).id, 'testing_aion_35_mini', 'Retained Aion keeps its previous ID');
  assert.deepEqual((await db.query('SELECT "modelId" FROM "SyntheticSelection" ORDER BY "modelId"')).rows,
    [{ modelId: 'old-0' }, { modelId: 'preserved-id' }], 'Choices remain linked, including retired models');
  for (const model of catalog) {
    const stored = rows.find(row => row.name === model.name);
    for (const [key, value] of Object.entries(model)) assert.deepEqual(stored[key], value, `SQL/catalog agree for ${model.name}: ${key}`);
    assert.equal(stored.isActive, true); assert.equal(stored.isFreeForSubscribers, false);
  }
  let session = null;
  const visibleRows = (query) => rows.filter(model => model.isActive && !query.where.name.notIn.includes(model.name));
  const api = load('src/app/api/models/route.ts', {
    '@/lib/testingChatModels': policy, 'next/server': { NextResponse },
    'next-auth/next': { getServerSession: async () => session },
    '@/lib/verseChatEconomy': { isSubscriptionActive: () => false },
    '@/lib/prisma': { prisma: { model: { findMany: async query => {
      assert.deepEqual(query.where.name.notIn, policy.RETIRED_TESTING_CHAT_MODEL_NAMES);
      return visibleRows(query);
    } }, user: { findUnique: async () => ({ selectedModelId: 'preserved-id' }) } } },
  });
  const response = await api.GET(); assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.models.filter(model => model.isTesting).length, 8);
  assert.equal(payload.models.length, 18);
  assert.equal(payload.baseModelId, 'base', 'Experimental model does not become the default');
  session = { user: { id: 'synthetic-user' } };
  assert.equal((await (await api.GET()).json()).selectedModelId, null, 'API does not advertise a retired saved selection');
  let selectionWrites = 0;
  const select = load('src/app/api/user/select-model/route.ts', {
    '@/lib/testingChatModels': policy, 'next/server': { NextRequest, NextResponse },
    'next-auth/next': { getServerSession: async () => session },
    '@/lib/prisma': { prisma: {
      model: { findFirst: async query => {
        assert.deepEqual(query.where.name.notIn, policy.RETIRED_TESTING_CHAT_MODEL_NAMES);
        // Keep retired fixture active: code must reject it even before SQL.
        return rows.map(row => ({ ...row, isActive: true })).find(row => row.id === query.where.id && !query.where.name.notIn.includes(row.name));
      } },
      user: { update: async ({ data }) => { selectionWrites++; return { selectedModelId: data.selectedModelId }; } },
    } },
  });
  const selectionRequest = id => new NextRequest('https://example.test/api/user/select-model', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: id }),
  });
  for (const name of policy.RETIRED_TESTING_CHAT_MODEL_NAMES) {
    assert.equal((await select.POST(selectionRequest(rows.find(row => row.name === name).id))).status, 400);
  }
  assert.equal(selectionWrites, 0);
  for (const model of catalog) assert.equal((await select.POST(selectionRequest(rows.find(row => row.name === model.name).id))).status, 200);
  assert.equal(selectionWrites, 8);

  const pickerFile = readFileSync('src/app/chat/[id]/ChatPageClient.tsx', 'utf8');
  const ast = ts.createSourceFile('picker.tsx', pickerFile, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const picker = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ModelSettingsList');
  assert.ok(picker);
  const code = ts.transpileModule('export ' + picker.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function('React', 'useState', 'useTranslation', 'MODEL_DESCRIPTIONS', 'getEffectiveModelPriceVC', 'FaChevronUp', 'FaChevronDown', 'module', 'exports', code)(
    React, React.useState, () => ({ i18n: { language: 'ru' } }), {}, () => 0, () => null, () => null, loadedModule, loadedModule.exports);
  const markup = renderToStaticMarkup(React.createElement(loadedModule.exports.ModelSettingsList, {
    models: payload.models, selectedModelId: 'base', baseModel: null, balance: null, changingModel: false, onModelChange() {},
  }));
  assert.ok(markup.indexOf('Основные модели') < markup.indexOf('Тестируется'));
  assert.match(markup, /Отключение рассуждений через шлюз ещё проверяем/);
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 18);
  for (const model of catalog) { assert.ok(markup.includes(model.displayName)); assert.ok(markup.includes(`${model.priceVC} VC/запрос`)); }
  for (const name of policy.RETIRED_TESTING_CHAT_MODEL_NAMES) assert.ok(!payload.models.some(model => model.name === name));
} finally { await db.close(); }
console.log('PASS: 17-model/4-plan matrix, eight testing/seven additions/four retirements, atomic rollback and replay, preserved selections, fallback/selection/API/picker, accounting quotes and stream settings');
