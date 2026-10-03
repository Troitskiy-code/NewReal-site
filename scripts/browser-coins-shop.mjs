import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function verifyCoinsBrowser({ db, context, page, base, user, character, check }) {
  const fakeCounter = route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `
    window.__coinsGoals=[]; window.ym=function(id,method,goal,params,callback){
      if(method==='init'){window['yaCounter'+id]={};setTimeout(()=>window.dispatchEvent(new Event('yacounter'+id+'inited')),0);}
      if(method==='reachGoal'){window.__coinsGoals.push({goal,params});if(callback)callback();}
    };` });
  await context.route('https://mc.yandex.*/metrika/tag.js', fakeCounter);
  const bankStub = route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Private payment stub</body></html>' });
  await context.route('https://auth.robokassa.ru/**', bankStub);
  let checkout;
  const captureCheckout = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    checkout = await response.json();
    await route.fulfill({ response });
  };
  await page.route('**/api/payment/create', captureCheckout);
  const shopUrl = `${base}/ru/coins?characterId=${character.id}`;
  try {
    await page.goto(shopUrl, { timeout: 120000 });
    await page.getByText('Первое знакомство', { exact: true }).waitFor();
    const hero = page.getByTestId('coins-hero-offer');
    check(await hero.getByText('500', { exact: false }).count() > 0 && await hero.getByText('129 ₽', { exact: false }).count() > 0,
      'coins first screen presents 500 VC for 129 RUB');
    check((await page.locator('#coins-hero-title').textContent()).includes(character.name)
      && await page.getByRole('link', { name: 'Назад в диалог' }).getAttribute('href') === `/ru/chat/${character.id}`,
      'coins hero restores authorized character and internal return link');
    check(await page.locator('[data-testid^="vc-pack-"]').count() === 6, 'coins renders six ordinary packages as cards');
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env['COINS_PREVIEW_DIRECTORY']) await page.screenshot({ path: join(process.env['COINS_PREVIEW_DIRECTORY'], 'coins-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile coins page has no horizontal overflow');
    const mobileButton = await page.getByTestId('coins-hero-buy').boundingBox();
    check(mobileButton.y >= 0 && mobileButton.y + mobileButton.height <= 844, 'first purchase button is visible on initial mobile viewport');
    if (process.env['COINS_PREVIEW_DIRECTORY']) await page.screenshot({ path: join(process.env['COINS_PREVIEW_DIRECTORY'], 'coins-mobile.png'), fullPage: false });
    await page.getByTestId('coins-hero-buy').click();
    await page.getByRole('dialog').waitFor();
    check((await page.getByRole('dialog').textContent()).includes('Без подписки и автопродления'), 'checkout makes one-time charge explicit');
    await page.keyboard.press('Escape');
    check(await page.getByRole('dialog').count() === 0, 'checkout supports keyboard cancellation');
    await page.getByTestId('coins-hero-buy').click();
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    await page.getByRole('dialog').getByRole('button', { name: 'Перейти к оплате' }).click();
    await page.waitForURL('https://auth.robokassa.ru/**', { timeout: 120000 });
    check(checkout.fields.OutSum === '129.00' && checkout.fields.Shp_vc === '500' && !checkout.fields.Recurring,
      'real browser checkout submits canonical first pack without recurrence');
    const returned = new URL(checkout.fields.SuccessUrl2);
    returned.searchParams.set('InvId', checkout.fields.InvId);
    await page.goto(`${base}${returned.pathname}${returned.search}`, { timeout: 120000 });
    await page.getByText('Платёж обрабатывается. Купленные VC появятся на балансе после подтверждения.', { exact: true }).waitFor();
    check(await page.getByRole('link', { name: 'Вернуться в диалог' }).count() === 0
      && (await db.user.findUniqueOrThrow({ where: { id: user.id } })).verseCoins === before.verseCoins,
      'return from bank does not claim success or grant first pack before webhook');
    const fields = { OutSum: checkout.fields.OutSum, InvId: checkout.fields.InvId,
      ...Object.fromEntries(Object.entries(checkout.fields).filter(([key]) => key.startsWith('Shp_'))) };
    const suffix = Object.keys(fields).filter(key => key.startsWith('Shp_')).sort().map(key => `${key}=${fields[key]}`).join(':');
    fields.SignatureValue = createHash('md5').update(`${fields.OutSum}:${fields.InvId}:synthetic_result_password:${suffix}`).digest('hex');
    const webhook = await context.request.post(`${base}/api/payment/webhook`, { form: fields, timeout: 120000 });
    check(webhook.status() === 200, 'first pack webhook works through real HTTP with no-DDL DB role');
    await page.getByRole('link', { name: 'Вернуться в диалог' }).waitFor();
    await page.getByText('Разовое пополнение', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__coinsGoals?.some(item => item.goal === 'vc_purchase_success'));
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    check(after.permanentCoins === before.permanentCoins + 500 && after.subscriptionType === before.subscriptionType,
      'first pack adds permanent VC and preserves subscription state');
    check(await page.evaluate(() => window.__coinsGoals.some(item => item.goal === 'vc_purchase_success' && item.params.order_price === 129)),
      'first pack uses server-confirmed VC conversion amount');
    await page.getByRole('link', { name: 'Вернуться в диалог' }).click();
    await page.waitForURL(`**/chat/${character.id}`);
    check(true, 'confirmed purchase returns to the original character chat');
    await page.goto(`${base}/en/coins`, { timeout: 120000 });
    await page.getByText('One-time top-up', { exact: true }).waitFor();
    check(await page.getByText('First introduction', { exact: true }).count() === 0,
      'English coins shop hides introductory pack after confirmed purchase');
    const repeat = await context.request.post(`${base}/api/payment/create`, { data: { packageId: 7 }, timeout: 120000 });
    check(repeat.status() === 409, 'authenticated browser cannot bypass consumed first offer');
  } finally {
    await page.unroute('**/api/payment/create', captureCheckout);
    await context.unroute('https://auth.robokassa.ru/**', bankStub);
    await context.unroute('https://mc.yandex.*/metrika/tag.js', fakeCounter);
  }
}
