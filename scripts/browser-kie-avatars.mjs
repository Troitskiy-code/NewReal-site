// Real local editor UI, synthetic session/API. External requests are blocked before navigation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(40000 + Math.floor(Math.random() * 20000), '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(?:KEY|SECRET|TOKEN|DATABASE|DIRECT_URL|LOGTAIL)/i.test(key)) env[key] = '';
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(name)) for (const line of readFileSync(name, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) env[match[1]] = '';
  }
}
Object.assign(env, { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1',
  DIRECT_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1',
  NEXTAUTH_SECRET: 'synthetic-local-editor-test-secret', NEXTAUTH_URL: base,
  NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_SITE_URL: base, RP_PROMPT_V2_ENABLED: 'true', NODE_ENV: 'production' });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
let browser;
let passed = 0;
const check = (condition, label) => { assert.ok(condition, label); passed++; console.log(`PASS ${label}`); };
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(base + '/robots.txt')).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r,500));
  }
  assert.ok(ready);
  browser = await chromium.launch({channel:'msedge',headless:true});
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  let userId = 'fixture_owner', job = null, posts = 0, used = 0, finish = false, failNext = false, loseNext = false;
  const payloads = [], errors = [];
  const tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const limits = () => ({tokensUsedThisMonth:used,monthlyLimit:9,monthlyRemaining:9-used});
  await context.route('**/*',async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base) return route.abort();
    const json = (body,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (url.pathname === '/api/auth/session') return json({user:{id:userId,name:'Fixture',email:'fixture@example.test',emailVerified:new Date().toISOString()},expires:'2030-01-01T00:00:00Z'});
    if (url.pathname === '/api/avatar-tokens') return json(limits());
    if (url.pathname === '/api/user/balance') return json({verseCoins:50,canClaimBonus:false});
    if (url.pathname === '/api/currency/rates') return json({USD:85,EUR:95});
    if (url.pathname === '/api/generate-avatar') {
      if (req.method() === 'POST') {
        posts++; const body = req.postDataJSON(); payloads.push(body); used++;
        job = {jobId:'fixture_job_'+posts,clientKey:body.clientKey,scope:body.scope,state:failNext?'failed':'pending',userId};
        if (failNext) { used--; job.error = 'Генерация возвращена в лимит'; failNext = false; }
        if (loseNext) { loseNext = false; return route.abort(); }
      } else if (job?.userId === userId && finish && job.state === 'pending') {
        job.state = 'succeeded'; job.imageUrl = tinyImage;
      }
      return json({...((job?.userId === userId) ? job : {state:'none'}),tokenStatus:limits()},req.method()==='POST'?202:200);
    }
    if (url.pathname.startsWith('/api/')) return json([]);
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror',e => errors.push(e.message));
  await page.goto(base + '/ru/create/character');
  await page.locator('#name').fill('Тестовый герой');
  await page.getByText('Генерация по описанию',{exact:true}).waitFor();
  check(await page.getByRole('radiogroup',{name:'Модель генерации аватара'}).count() === 0,'model selector removed');
  check(await page.getByRole('radio',{name:'Аниме',exact:true}).isVisible() && await page.getByRole('radio',{name:'Реалистичный',exact:true}).isVisible(),'style controls retained');
  await page.getByRole('radio',{name:'Аниме',exact:true}).click();
  await page.locator('#generate-avatar-btn').click();
  await page.waitForFunction(() => document.querySelector('#generate-avatar-btn')?.disabled);
  check(posts === 1 && !payloads[0].modelId && !payloads[0].referenceImage && payloads[0].style === 'anime','text request has style but no chosen model');
  await page.reload();
  await page.getByRole('button',{name:'Проверить результат',exact:true}).waitFor();
  check(await page.locator('#generate-avatar-btn').isDisabled() && posts === 1,'reload resumes existing run without paid POST');
  finish = true; await page.getByRole('button',{name:'Проверить результат',exact:true}).click();
  await page.locator('img[src^="data:image/"]').first().waitFor();
  check(await page.locator('#generate-avatar-btn').isEnabled(),'completed task fills preview and releases UI');
  await page.reload();
  await page.getByRole('button',{name:'Восстановить последнее изображение',exact:true}).waitFor();
  check(await page.locator('img[src^="data:image/"]').count() === 0,'historical completed image is not silently applied to a fresh draft');
  await page.getByRole('button',{name:'Восстановить последнее изображение',exact:true}).click();
  await page.locator('img[src^="data:image/"]').first().waitFor();
  check(await page.getByRole('button',{name:'Восстановить последнее изображение',exact:true}).count() === 0,'explicit restore applies preview once');
  await page.getByText('Изображение-референс (необязательно)',{exact:true}).click();
  await page.locator('input[type="file"]').last().setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(tinyImage.split(',')[1],'base64')});
  await page.getByText('Генерация по референсу',{exact:true}).waitFor();
  finish = false; await page.locator('#name').fill('Референс');
  await page.locator('#generate-avatar-btn').click();
  await page.waitForFunction(() => document.querySelector('#generate-avatar-btn')?.disabled);
  check(posts === 2 && payloads[1].referenceImage.startsWith('data:image/png;base64,') && !payloads[1].modelId,'reference request lets the server select Nano Banana');
  finish = true; await page.getByRole('button',{name:'Проверить результат',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('#generate-avatar-btn')?.disabled);
  failNext = true;
  await page.locator('#generate-avatar-btn').click();
  await page.getByText('Генерация возвращена в лимит',{exact:true}).first().waitFor();
  check(used === 2 && await page.getByText('Месячный лимит: осталось 7 из 9 генераций',{exact:true}).isVisible(),'failed task updates refunded quota on screen');
  loseNext = true; finish = false;
  await page.locator('#generate-avatar-btn').click();
  await page.waitForFunction(() => document.querySelector('#generate-avatar-btn')?.disabled);
  check(posts === 4,'lost POST response recovers through GET, without another POST');
  finish = true; await page.getByRole('button',{name:'Проверить результат',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('#generate-avatar-btn')?.disabled);
  check(await page.evaluate(() => !sessionStorage.getItem('nv-kie-request:fixture_owner:create:character')),'recovery clears only the acknowledged request key');
  finish = false; await page.locator('#generate-avatar-btn').click();
  await page.waitForFunction(() => document.querySelector('#generate-avatar-btn')?.disabled);
  check(posts === 5 && payloads[4].clientKey !== payloads[3].clientKey,'next intentional generation uses a fresh idempotency key');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#generate-avatar-btn').scrollIntoViewIfNeeded();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'mobile generation block fits viewport');
  const out = process.env['KIE_BROWSER_OUTPUT'];
  if (out) { mkdirSync(out,{recursive:true}); await page.screenshot({path:out+'/mobile.png'}); }
  userId = 'fixture_other'; await page.reload();
  await page.getByText('Генерация по описанию',{exact:true}).waitFor();
  check(await page.getByRole('button',{name:'Восстановить последнее изображение',exact:true}).count() === 0
    && await page.locator('img[src^="data:image/"]').count() === 0,'account change does not restore another user image');
  check(errors.length === 0,'no uncaught browser errors: '+errors.join(';'));
  console.log(passed+' Kie browser checks passed; no external or paid calls.');
} finally { if (browser) await browser.close(); server.kill(); }
