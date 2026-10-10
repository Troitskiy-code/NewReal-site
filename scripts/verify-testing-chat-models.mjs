// Disposable SQL database, real request builders and rendered picker. No live AI or .env.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { NextResponse } from 'next/server.js';

function load(file, dependencies = {}) {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => dependencies[name] ?? {}, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const catalog = JSON.parse(readFileSync('src/lib/data/testing-chat-models-2026-10-10.json', 'utf8'));
const policy = load('src/lib/testingChatModels.ts', { './data/testing-chat-models-2026-10-10.json': catalog });
assert.equal(catalog.length, 5);
assert.equal(new Set(catalog.map(model => model.name)).size, 5);
const expectedVC = [4, 18, 23, 22, 38];
assert.deepEqual(catalog.map(model => model.priceVC), expectedVC);
assert.deepEqual(policy.chatModelGenerationOptions('existing-model'), { max_tokens: 1000, temperature: 0.7 });
assert.equal(policy.chatModelRequestTimeoutMs('existing-model'), 30000);
assert.equal(policy.chatModelGenerationOptions(catalog[0].name).reasoning.enabled, false);
assert.equal(policy.chatModelGenerationOptions(catalog[3].name).reasoning.effort, 'none');
assert.equal(policy.chatModelGenerationOptions(catalog[4].name).reasoning.effort, 'low');
assert.equal(policy.chatModelGenerationOptions(catalog[4].name).max_tokens, 4000);

const requests = [];
const economy = load('src/lib/chatEconomy.ts');
const helpers = load('src/lib/chatHelpers.ts', {
  '@/lib/testingChatModels': policy,
  '@/lib/verseChatEconomy': economy,
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
assert.equal(helpers.resolveContextTokenBudget(universe, { name: catalog[4].name, maxContextTokens: 12000 }), 8000);
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
const resolveGuestModel = new Function('prisma', 'TESTING_CHAT_MODEL_NAMES', guestCode + '\nreturn resolveAnonymousModel;')({
  model: { findFirst: async query => { guestQueries.push(query); return null; } },
}, policy.TESTING_CHAT_MODEL_NAMES);
await resolveGuestModel();
assert.equal(guestQueries.length, 2);
assert.deepEqual(guestQueries[1].where.name.notIn, catalog.map(model => model.name));

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
  const knownNames = new Set([...existingCatalog, ...catalog].map(model => model.name));
  assert.equal(after.filter(model => model.maxContextTokens === 20000).length, 14);
  assert.deepEqual(after, before.map(model => knownNames.has(model.name) ? { ...model, maxContextTokens: 20000 } : model),
    'Context SQL changes only the window for known names, preserving every other field and unknown models');
  assert.deepEqual((await db.query('SELECT "modelId" FROM "SyntheticSelection" ORDER BY "modelId"')).rows,
    [{ modelId: 'old-0' }, { modelId: 'preserved-id' }]);
  // The following API/picker fixture deliberately keeps its original six rows.
  await db.exec('DELETE FROM "SyntheticSelection" WHERE "modelId" = \'old-0\'; DELETE FROM "Model" WHERE id LIKE \'old-%\';');
  const { rows } = await db.query('SELECT * FROM "Model" ORDER BY "priceVC", "createdAt"');
  assert.equal(rows.length, 6, 'SQL can be repeated without duplicating or removing models');
  assert.equal(rows.find(model => model.name === 'existing-model').priceVC, 4);
  assert.equal((await db.query('SELECT "modelId" FROM "SyntheticSelection"')).rows[0].modelId, 'preserved-id');
  for (const model of catalog) {
    const stored = rows.find(row => row.name === model.name);
    for (const [key, value] of Object.entries(model)) assert.deepEqual(stored[key], value, `SQL/catalog agree for ${model.name}: ${key}`);
    assert.equal(stored.isActive, true); assert.equal(stored.isFreeForSubscribers, false);
  }
  const api = load('src/app/api/models/route.ts', {
    '@/lib/testingChatModels': policy, 'next/server': { NextResponse },
    'next-auth/next': { getServerSession: async () => null },
    '@/lib/prisma': { prisma: { model: { findMany: async () => rows } } },
  });
  const response = await api.GET(); assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.models.filter(model => model.isTesting).length, 5);
  assert.equal(payload.baseModelId, 'base', 'Experimental model does not become the default');

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
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 6);
  for (const model of catalog) { assert.ok(markup.includes(model.displayName)); assert.ok(markup.includes(`${model.priceVC} VC/запрос`)); }
} finally { await db.close(); }
console.log('PASS: 14-model/4-plan matrix, expired/guest budgets, repeatable SQL preserving prices and selections, API/picker, stream/non-stream settings');
