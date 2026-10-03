import assert from 'node:assert/strict';

// Real forms and guest stream on private Next + PostgreSQL; synthetic counter only.
export async function verifyAcquisitionBrowser({ browser, base, character, check }) {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (/^https:\/\/mc\.yandex\.(com|ru)\/metrika\/tag\.js$/.test(url)) {
      return route.fulfill({ contentType: 'application/javascript', body: `
        window.ym=function(id,method,goal,params,callback){
          if(id!==999001) throw Error('Unexpected counter');
          if(method==='init'){window['yaCounter'+id]={};setTimeout(()=>window.dispatchEvent(new Event('yacounter'+id+'inited')),0);}
          if(method==='reachGoal'){var calls=JSON.parse(sessionStorage.getItem('test:goals')||'[]');calls.push(goal);sessionStorage.setItem('test:goals',JSON.stringify(calls));if(callback)callback();}
        };` });
    }
    if (url.startsWith(base)) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const count = goal => page.evaluate(name => JSON.parse(sessionStorage.getItem('test:goals') || '[]').filter(item => item === name).length, goal);
  const email = `acquisition-${Date.now()}@example.test`;
  const fillRegistration = async (confirmation = 'SyntheticTest123!') => {
    await page.locator('form input[type=text]').fill('Synthetic acquisition');
    await page.locator('form input[type=email]').fill(email);
    await page.locator('form input[type=password]').nth(0).fill('SyntheticTest123!');
    await page.locator('form input[type=password]').nth(1).fill(confirmation);
    for (const checkbox of await page.locator('input[type=checkbox]').all()) await checkbox.check();
  };
  try {
    await page.goto(`${base}/ru/register`, { timeout: 120000 });
    await fillRegistration('DifferentPassword123!');
    await page.locator('#register-submit').click();
    check(await count('register_success') === 0 && await count('register') === 0, 'register form mismatch cannot count successful signup');
    await page.locator('form input[type=password]').nth(1).fill('SyntheticTest123!');
    const created = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
    await page.locator('#register-submit').click();
    assert.equal((await created).status(), 201);
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('test:goals') || '[]').includes('register_success'));
    check(await count('register_success') === 1 && await count('register') === 1, 'real created account emits successful signup goals');
    await page.waitForURL('**/login');
    await page.goto(`${base}/ru/register`, { timeout: 120000 }); await fillRegistration();
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
    await page.locator('#register-submit').click(); assert.equal((await rejected).status(), 400);
    check(await count('register_success') === 1 && await count('register') === 1, 'server-rejected duplicate signup emits no conversion');

    const chatUrl = `${base}/ru/chat/${character.id}`;
    await page.goto(chatUrl, { timeout: 120000 });
    const chatRoute = `**/api/chat/${character.id}`;
    const fail = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic unavailable"}' }) : route.continue();
    await page.route(chatRoute, fail);
    await page.locator('textarea').first().fill('Rejected synthetic turn');
    const failed = page.waitForResponse(response => response.url().endsWith(`/api/chat/${character.id}`) && response.status() === 503);
    await page.locator('textarea').first().press('Enter'); await failed;
    await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false);
    check(await count('send_message') === 0 && await count('chat_engaged') === 0, 'real chat HTTP failure creates no success conversion');
    await page.unroute(chatRoute, fail);
    const partial = route => route.request().method() === 'POST'
      ? route.fulfill({ contentType: 'application/x-ndjson', body: '{"type":"delta","text":"Incomplete synthetic reply"}\n' }) : route.continue();
    await page.route(chatRoute, partial);
    await page.locator('textarea').first().fill('Interrupted synthetic turn');
    const interrupted = page.waitForResponse(response => response.url().endsWith(`/api/chat/${character.id}`) && response.request().method() === 'POST');
    await page.locator('textarea').first().press('Enter'); await interrupted;
    await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false);
    check(await count('send_message') === 0, 'real truncated stream creates no success conversion');
    await page.unroute(chatRoute, partial);
    for (let turn = 1; turn <= 3; turn++) {
      await page.locator('textarea').first().fill(`Successful acquisition turn ${turn}`);
      await page.locator('textarea').first().press('Enter');
      await page.waitForFunction(expected => JSON.parse(sessionStorage.getItem('test:goals') || '[]').filter(item => item === 'send_message').length === expected, turn);
      if (turn === 1) {
        await page.reload(); await page.getByText('Successful acquisition turn 1', { exact: true }).waitFor();
        check(await count('send_message') === 1, 'real history reload does not replay send conversion');
      }
      if (turn < 3) check(await count('chat_engaged') === 0, `engagement does not fire after ${turn} real reply`);
    }
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('test:goals') || '[]').includes('chat_engaged'));
    check(await count('send_message') === 3 && await count('chat_engaged') === 1, 'three completed guest replies produce one engaged conversion');
    await page.reload(); await page.getByText('Successful acquisition turn 3', { exact: true }).waitFor();
    check(await count('send_message') === 3 && await count('chat_engaged') === 1, 'engagement and turn goals remain deduplicated after reload');
  } finally { await context.close(); }
}
