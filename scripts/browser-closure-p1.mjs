import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function verifyP1Browser({ db, context, page, base, user, check }) {
  await page.goto(`${base}/ru/support`, { timeout: 120000 });
  await page.locator('#support-email').fill('browser-support@example.test');
  await page.locator('#support-message').fill('A real browser support message');
  let lostKey, ticketId, loseFirst = true;
  await page.route('**/api/support', async route => {
    const submitted = route.request().postDataJSON();
    if (loseFirst) {
      loseFirst = false; lostKey = submitted.clientKey;
      const actual = await route.fetch(); assert.equal(actual.status(), 201);
      ticketId = (await actual.json()).ticketId;
      await route.abort('connectionclosed');
    } else {
      assert.equal(submitted.clientKey, lostKey);
      await route.continue();
    }
  });
  await page.locator('form button[type=submit]').click();
  await page.locator('main p.text-red-400').waitFor();
  check(Boolean(ticketId), 'browser lost response occurs after real ticket persistence');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#support-message')?.value === 'A real browser support message');
  await page.locator('form button[type=submit]').click();
  await page.getByText(new RegExp(ticketId)).waitFor();
  check(await db.supportTicket.count({ where: { clientKey: lostKey } }) === 1, 'browser reload/retry displays same ticket without duplicate');
  await page.unroute('**/api/support');
  const profile = await context.request.get(`${base}/api/user/characters`, { timeout: 120000 });
  check(profile.status() === 200, 'full application profile handler works with no-DDL DB role');
  check((await context.request.get(`${base}/api/cron/deliver-support`, { timeout: 120000 })).status() === 401, 'outbox cron rejects unauthenticated HTTP request');
  const alert = await context.request.get(`${base}/api/cron/deliver-support`, { timeout: 120000, headers: { authorization: 'Bearer synthetic_cron_only' } });
  check(alert.status() === 503 && (await alert.json()).requiresAttention, 'real cron exposes terminal/legacy delivery for monitoring');
  const cleaned = await context.request.get(`${base}/api/cron/cleanup-anonymous`, { timeout: 120000, headers: { authorization: 'Bearer synthetic_cron_only' } });
  check(cleaned.status() === 200, 'real cleanup cron works with no-DDL DB role');

  const mockTag = `(function(){ window.__closureGoals=[]; window.ym=function(id,method,goal,params,callback){
    if(method==='init'){ window['yaCounter'+id]={}; setTimeout(()=>window.dispatchEvent(new Event('yacounter'+id+'inited')),0); }
    if(method==='reachGoal'){window.__closureGoals.push(goal);if(callback)callback();}
  };})();`;
  await context.route('https://mc.yandex.*/metrika/tag.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: mockTag }));
  const invId = '99001';
  const pending = await context.request.get(`${base}/api/payment/status?invId=${invId}`, { timeout: 120000 });
  check(pending.status() === 200 && (await pending.json()).status === 'pending', 'real owner-scoped API is pending before webhook');
  await page.goto(`${base}/ru/coins?InvId=${invId}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__nvMetrika?.counterReady);
  check(await page.evaluate(() => !window.__closureGoals.includes('vc_purchase_success')), 'browser does not report purchase before confirmation');
  const fields = { OutSum: '129.00', InvId: invId, Shp_userId: user.id, Shp_vc: '100' };
  const suffix = Object.keys(fields).filter(k => k.startsWith('Shp_')).sort().map(k => `${k}=${fields[k]}`).join(':');
  fields.SignatureValue = createHash('md5').update(`${fields.OutSum}:${invId}:synthetic_result_password:${suffix}`).digest('hex');
  const webhook = await context.request.post(`${base}/api/payment/webhook`, { timeout: 120000, maxRetries: 2, form: fields });
  check(webhook.status() === 200 && await webhook.text() === `OK${invId}`, 'real HTTP signed webhook commits test purchase');
  await page.waitForFunction(() => window.__closureGoals?.includes('vc_purchase_success'));
  check((await page.evaluate(() => window.__closureGoals.filter(g => g === 'vc_purchase_success').length)) === 1, 'real DB confirmation dispatches one browser purchase goal');
  await page.reload(); await page.waitForFunction(() => window.__nvMetrika?.counterReady);
  check((await page.evaluate(() => window.__closureGoals.filter(g => g === 'vc_purchase_success').length)) === 0, 'completed real purchase is not dispatched again after reload');

  // Exercise the OAuth success tracker via a server-session fixture. The external
  // Google provider itself remains an operator smoke test, no credentials used.
  await context.route('**/api/auth/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    session.user.oauthLoginEventId = 'synthetic-google-login-event';
    await route.fulfill({ response, json: session });
  });
  await page.reload();
  await page.waitForFunction(() => window.__closureGoals?.includes('login'));
  check((await page.evaluate(() => window.__closureGoals.filter(g => g === 'login').length)) === 1, 'OAuth session success dispatches login after counter readiness');
  await page.reload(); await page.waitForFunction(() => window.__nvMetrika?.counterReady);
  check((await page.evaluate(() => window.__closureGoals.filter(g => g === 'login').length)) === 0, 'OAuth success event is not repeated on reload');
  await context.unroute('**/api/auth/session');
}
