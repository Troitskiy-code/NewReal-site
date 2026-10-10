// Actual React editor in Chromium, fixture API only. No Next server, database, or live providers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'nv-memory-editor-'));
const loader = join(directory, 'loader.cjs');
writeFileSync(loader, `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText};`);
writeFileSync(join(directory, 'toast.js'), 'export const showError=message=>window.__toasts.push(message);export const showSuccess=message=>window.__toasts.push(message);');
writeFileSync(join(directory, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import MemoryEditor from ${JSON.stringify(join(root, 'src/components/MemoryEditor.tsx'))};window.__toasts=[];const root=createRoot(document.getElementById('root'));window.renderEditor=characterId=>root.render(<MemoryEditor characterId={characterId} onClose={()=>{}}/>);window.renderEditor('a');`);
await new Promise((done, reject) => {
  const compiler = webpack({ mode: 'development', devtool: false, target: 'web',
    entry: join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js' },
    resolve: { modules: [join(root, 'node_modules')], extensions: ['.ts', '.tsx', '.js'],
      alias: { '@/lib/toast$': join(directory, 'toast.js'), '@': join(root, 'src') } },
    module: { rules: [{ test: /\.tsx?$/, use: loader }] },
  });
  compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
    ? reject(error ?? new Error(stats.toString({ all: false, errors: true }))) : done()));
});
const bundle = readFileSync(join(directory, 'bundle.js'));
let plan = [], requests = [], release;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(bundle); return; }
  if (req.url?.startsWith('/api/chat/')) {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ summary: { summary: req.url.includes('/b/') ? 'Сводка Б' : 'Прежняя сводка', createdAt: '2026-10-10' }, core: null, episodic: [] })); return; }
    let text = ''; for await (const part of req) text += part;
    requests.push({ url: req.url, body: JSON.parse(text) });
    const step = plan.shift();
    if (!step) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Unexpected fixture request' })); return; }
    if (step.hold) await new Promise(done => { release = done; });
    res.statusCode = step.code ?? 200; res.end(JSON.stringify(step.value)); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<html lang="ru"><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser, passed = 0;
let page;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
async function waitRequests(count) {
  const until = Date.now() + 10000;
  while (requests.length < count && Date.now() < until) await new Promise(done => setTimeout(done, 20));
  assert.ok(requests.length >= count, `Expected ${count} fixture requests, got ${requests.length}`);
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env['MEMORY_TEST_BROWSER_CHANNEL'] ? { channel: process.env['MEMORY_TEST_BROWSER_CHANNEL'] } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const draft = page.locator('#memory-summary');
  await draft.waitFor();
  const confirm = page.getByRole('checkbox');
  const rebuild = page.getByRole('button', { name: 'Пересобрать из переписки', exact: true });
  check('replacement remains disabled until the explicit checkbox is checked', () => {});
  assert.equal(await rebuild.isDisabled(), true);
  plan = [{ value: { status: 'rebuilding', continuation: 'fixture-step-2', processed: 120, total: 150 } },
    { hold: true, value: { status: 'updated', summary: { summary: 'Связная новая сводка', createdAt: '2026-10-10' } } }];
  await confirm.check(); await rebuild.click();
  await page.getByRole('status').waitFor();
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('120 из 150'));
  await waitRequests(2);
  check('draft stays unchanged until final completion and continuation is sent', () => {
    assert.deepEqual(requests.map(item => item.body), [
      { mode: 'rebuild', confirm: true }, { mode: 'rebuild', confirm: true, continuation: 'fixture-step-2' },
    ]);
  });
  assert.equal(await draft.inputValue(), 'Прежняя сводка');
  release();
  await page.waitForFunction(() => document.querySelector('#memory-summary')?.value === 'Связная новая сводка');
  check('completed rebuild replaces only the displayed summary', () => {});
  assert.equal(await rebuild.isDisabled(), true);
  plan = [{ code: 503, value: { error: 'Подставная ошибка провайдера' } }];
  await confirm.check(); await rebuild.click();
  await page.waitForFunction(() => window.__toasts.includes('Подставная ошибка провайдера'));
  check('failed request shows its error and retains the previous draft', () => {});
  assert.equal(await draft.inputValue(), 'Связная новая сводка');
  plan = [{ value: { status: 'conflict', summary: { summary: 'Ручная каноническая версия', createdAt: '2026-10-10' } } }];
  await confirm.check(); await rebuild.click();
  await page.waitForFunction(() => document.querySelector('#memory-summary')?.value === 'Ручная каноническая версия');
  check('conflict displays canonical storage and a visible explanation', () => {});
  assert.equal(await page.evaluate(() => window.__toasts.some(text => text.includes('Память изменилась'))), true);
  plan = [{ value: { status: 'rebuilding', continuation: 'cancel-step', processed: 120, total: 300 } },
    { hold: true, value: { status: 'rebuilding', continuation: 'cancel-next', processed: 240, total: 300 } }];
  const previous = requests.length;
  await confirm.check(); await rebuild.click(); await page.getByRole('status').waitFor();
  await waitRequests(previous + 2);
  await page.getByRole('button', { name: 'Остановить после текущего шага' }).click(); release();
  await page.waitForFunction(() => !document.querySelector('[role=status]'));
  check('stop ends the loop after the in-flight step without publishing a partial draft', () => assert.equal(requests.length, previous + 2));
  assert.equal(await draft.inputValue(), 'Ручная каноническая версия');
  plan = [{ hold: true, value: { status: 'updated', summary: { summary: 'Поздний ответ А', createdAt: '2026-10-10' } } }];
  await confirm.check(); await rebuild.click();
  await waitRequests(previous + 3);
  await page.evaluate(() => window.renderEditor('b'));
  await page.waitForFunction(() => document.querySelector('#memory-summary')?.value === 'Сводка Б');
  release(); await page.evaluate(() => new Promise(done => setTimeout(done, 100)));
  check('late response from character A cannot replace character B memory', () => {});
  assert.equal(await draft.inputValue(), 'Сводка Б');
  check('no React runtime errors in the fixture', () => assert.deepEqual(errors, []));
  console.log(`${passed} passed`);
} catch (error) {
  console.error(JSON.stringify({ requests, state: await page?.evaluate(() => ({
    progress: document.querySelector('[role=status]')?.textContent,
    summary: document.querySelector('#memory-summary')?.value, toasts: window.__toasts,
  })) }));
  throw error;
} finally {
  release?.(); await browser?.close(); await new Promise(done => server.close(done));
}
