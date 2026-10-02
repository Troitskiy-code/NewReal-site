import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function verifyFirstVc({ db, load, check, webhook }) {
  const { NextRequest } = require('next/server');
  const buyer = await db.user.create({ data: { email: 'first-buyer@example.test', emailVerified: new Date(), verseCoins: 20, permanentCoins: 20 } });
  let activeUser = buyer, authenticated = false, locale = 'ru';
  const mocks = {
    '@/lib/auth': { authOptions: {} },
    'next-auth/next': { getServerSession: async () => authenticated ? { user: { id: activeUser.id, email: activeUser.email } } : null },
    '@/lib/getRequestLocale': { getRequestLocale: async () => locale },
    '@/lib/apiI18n': { apiT: (_req, key) => key },
    '@/lib/email': { sendVerificationEmail() { throw new Error('No real email in fixture'); } },
  };
  const create = load('src/app/api/payment/create/route.ts', mocks);
  const offer = load('src/app/api/coins/offer/route.ts', mocks);
  const body = extras => new NextRequest('http://localhost/api/payment/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 7, ...extras }) });
  check((await create.POST(body())).status === 401 && (await offer.GET()).status === 401, 'first pack checkout and eligibility require authentication');
  authenticated = true;
  await db.user.update({ where: { id: buyer.id }, data: { emailVerified: null } });
  check((await create.POST(body())).status === 403 && await db.firstVcPurchase.count() === 0, 'unverified email cannot reserve first pack');
  await db.user.update({ where: { id: buyer.id }, data: { emailVerified: new Date() } });
  await db.transaction.create({ data: { userId: buyer.id, amount: 20, type: 'admin_gift', description: 'Synthetic gift' } });
  check((await (await offer.GET()).json()).available, 'free gifts do not consume first purchase eligibility');
  const responses = await Promise.all(Array.from({ length: 8 }, () => create.POST(body({ desc: '999999999 VC', price: 0, vc: 999999999, characterId: 'fixture_character' }))));
  check(responses.every(response => response.status === 200), 'parallel first pack checkout succeeds without duplicate reservation');
  const checkouts = await Promise.all(responses.map(response => response.json()));
  const checkout = checkouts[0];
  check(new Set(checkouts.map(item => item.fields.InvId)).size === 1 && await db.firstVcPurchase.count({ where: { userId: buyer.id } }) === 1, 'parallel checkouts use one durable invoice per account');
  check(checkouts.every(item => item.fields.OutSum === '129.00' && item.fields.Shp_vc === '500' && item.fields.Shp_offer === 'first'
    && item.fields.Shp_packageId === '7' && !item.fields.Recurring && item.fields.Description === 'Покупка 500 VC'), 'server catalog fixes first pack amount and VC despite tampered client fields');
  const before = await db.user.findUniqueOrThrow({ where: { id: buyer.id } });
  check(before.permanentCoins === 20 && await db.paymentEvent.count({ where: { userId: buyer.id } }) === 0, 'creating first checkout never grants VC or confirms payment');
  locale = 'en';
  const resumed = await (await create.POST(body({ characterId: 'second_character' }))).json();
  check(resumed.fields.InvId === checkout.fields.InvId && resumed.fields.SuccessUrl2.includes('/en/coins?')
    && new URL(resumed.fields.SuccessUrl2).searchParams.get('characterId') === 'second_character', 'resumed invoice re-signs current locale and chat return context');
  const unsafeReturn = await (await create.POST(body({ characterId: '//evil.example' }))).json();
  check(!new URL(unsafeReturn.fields.SuccessUrl2).searchParams.has('characterId'), 'external return destinations cannot enter payment success URL');

  const signed = (overrides = {}) => {
    const fields = { OutSum: checkout.fields.OutSum, InvId: checkout.fields.InvId,
      ...Object.fromEntries(Object.entries(checkout.fields).filter(([key]) => key.startsWith('Shp_'))), ...overrides };
    const suffix = Object.keys(fields).filter(key => key.startsWith('Shp_')).sort().map(key => `${key}=${fields[key]}`).join(':');
    fields.SignatureValue = createHash('md5').update(`${fields.OutSum}:${fields.InvId}:synthetic_result_password:${suffix}`).digest('hex');
    return fields;
  };
  const deliver = fields => webhook.POST(new NextRequest('http://localhost/api/payment/webhook', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }));
  check((await deliver(signed({ OutSum: '128.99' }))).status === 409, 'first pack requires exact 129 RUB even with a valid signature');
  check((await deliver(signed({ Shp_vc: '1000' }))).status === 409, 'first pack rejects a signed amount outside reserved catalog VC');
  check((await deliver(signed({ InvId: '99999111' }))).status === 409, 'first pack webhook requires the reserved invoice');
  await db.$executeRawUnsafe("CREATE FUNCTION first_pack_notification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic first pack notification failure'; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER first_pack_notification_failure BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION first_pack_notification_failure()');
  try {
    check((await deliver(signed())).status === 500, 'failed first purchase notification returns failure rather than false success');
    check((await db.firstVcPurchase.findUniqueOrThrow({ where: { userId: buyer.id } })).status === 'pending'
      && (await db.user.findUniqueOrThrow({ where: { id: buyer.id } })).permanentCoins === 20
      && await db.paymentEvent.count({ where: { userId: buyer.id } }) === 0,
      'first purchase failure rolls back reserve completion, grant and payment event together');
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER first_pack_notification_failure ON "Notification"');
    await db.$executeRawUnsafe('DROP FUNCTION first_pack_notification_failure()');
  }
  const replies = await Promise.all([deliver(signed()), deliver(signed()), deliver(signed())]);
  check(replies.every(response => response.status === 200), 'parallel confirmed first purchase deliveries acknowledge one invoice');
  const paid = await db.user.findUniqueOrThrow({ where: { id: buyer.id } });
  check(paid.permanentCoins === 520 && paid.verseCoins === 520
    && await db.paymentEvent.count({ where: { userId: buyer.id } }) === 1
    && await db.transaction.count({ where: { userId: buyer.id, type: 'purchase' } }) === 1, 'first purchase atomically grants exactly 500 permanent VC once');
  check((await db.firstVcPurchase.findUniqueOrThrow({ where: { userId: buyer.id } })).status === 'completed'
    && !(await (await offer.GET()).json()).available && (await create.POST(body())).status === 409, 'completed first pack cannot be bought again');
  const meta = await db.paymentEvent.findFirstOrThrow({ where: { userId: buyer.id } });
  check(meta.kind === 'purchase' && meta.amountRub === 129, 'first pack confirmation supplies normal VC conversion metadata');
  activeUser = await db.user.create({ data: { email: 'prior-payer@example.test', emailVerified: new Date() } });
  await db.transaction.create({ data: { userId: activeUser.id, amount: 0, type: 'subscription', description: 'Historical subscription' } });
  check(!(await (await offer.GET()).json()).available && (await create.POST(body())).status === 409, 'historical subscription buyers cannot reserve introductory pack');
  const ordinary = await (await create.POST(body({ packageId: 1, desc: '999999999 VC', vc: 999999999 }))).json();
  check(ordinary.fields.OutSum === '300.00' && ordinary.fields.Shp_vc === '1000' && !ordinary.fields.Shp_offer, 'ordinary checkout remains available with authoritative price and VC');
  const returns = load('src/lib/coinsReturn.ts');
  assert.equal(returns.coinsHrefFromChat('/ru/chat/fixture_character'), '/coins?characterId=fixture_character');
  check(returns.coinsChatHref('//evil.example') === null && returns.coinsChatHref('fixture_character') === '/chat/fixture_character', 'chat return links accept only internal character IDs');
}
