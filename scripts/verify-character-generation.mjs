// Actual queue/transactions/admin routes against disposable PostgreSQL. All paid
// providers and storage are simulated; never loads .env or the production DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { NextRequest } from 'next/server.js';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';

const require = createRequire(import.meta.url), root = process.cwd();
const runtime = process.env.GUEST_TEST_RUNTIME;
if (!runtime) throw new Error('Set GUEST_TEST_RUNTIME to the existing isolated embedded-postgres installation');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const directory = mkdtempSync(join(tmpdir(), 'nv-character-generation-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_fixture',
  port, persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'] });
const databaseUrl = `postgresql://postgres:synthetic_fixture@127.0.0.1:${port}/nv_character_generation_test`;
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const ddl = new Client({ connectionString: databaseUrl });
const env = { DEEPINFRA_API_KEY: 'fixture', DEEPINFRA_USD_RUB: '108.192', KIE_API_KEY: 'fixture', YANDEX_API_KEY: 'fixture',
  YANDEX_FOLDER_ID: 'fixture', S3_ENDPOINT: 'https://storage.yandexcloud.net', S3_REGION: 'ru-central1', S3_BUCKET: 'fixture',
  S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', ADMIN_SECRET: 'fixture_admin', CRON_SECRET: 'fixture_cron' };
let ownerId, sessionOwner, textMode = 'ok', imageMode = 'ok', translationFailures = 0, reviewMode = 'ok';
let textCalls = 0, imageCalls = 0, translationCalls = 0, saves = 0;
const imageTasks = new Map(), logs = [], cache = new Map(), textRequests = [], reviewRequests = [];
let lostOnceAt = 0;
class FixtureKieError extends Error { constructor(code, rejected = false) { super(code); this.code = code; this.rejected = rejected; } }
const cardFixture = theme => {
  const sentence = 'Персонаж сохраняет самостоятельность, уважает решения собеседника, действует последовательно и постепенно раскрывает свои мотивы в разговоре. ';
  const age = typeof theme.age === 'number' ? theme.age + ' лет' : 'взрослый андроид';
  return { name: theme.name ?? 'Новое имя ' + theme.key, descriptionCard: theme.premise, description: theme.premise + sentence.repeat(3),
    appearance: `Взрослый персонаж, ${age}, аккуратная одежда, серые глаза, спокойная уверенная поза. ` + sentence,
    greeting: theme.opening + ' «С какого условия начнём? Я готов выслушать твой вариант и объяснить свой».',
    scenario: theme.premise, exampleDialogs: '{{user}}: Почему ты выбрал меня?\n{{char}}: ' + sentence + '\n{{user}}: Я хочу другой вариант.\n{{char}}: ' + sentence,
    avatarPrompt: 'Adult character in neat clothes, calm grey eyes, setting that matches the story, soft light, portrait.',
    tags: 'Романтика, Партнёр, Драма, Медленное развитие отношений',
    rpConfig: { ...Object.fromEntries(['motivations','speechStyle','relationships','world','narrativeRules'].map(key => [key, sentence])),
      canonicalNotes: `Возраст: ${age}. ` + sentence } };
};
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const dependency = name => {
    if (name === './prisma' || name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => sessionOwner ? { user: { id: sessionOwner } } : null };
    if (name === './logger' || name === '@/lib/logger') return { errorLog: (...args) => logs.push(args), toSafeDiagnostic: () => ({}) };
    if (name === './aiCostTelemetry') return { withAiCostContext: fn => fn() };
    if (name === './aiTextClient') return { serviceChatPost: async (_purpose, _url, body) => {
      if (body.messages[0].content.startsWith('Ты редактор')) {
        reviewRequests.push({ model: body.model, system: body.messages[0].content });
        const checks = Object.fromEntries(['age','timeline','canon','scene','userAgency','userGender','tags','appearance','text'].map(key => [key, true]));
        if (reviewMode === 'reject') checks.userAgency = false;
        const unsupportedTags = reviewMode === 'dropTag' ? ['Драма'] : reviewMode === 'dropMany' ? ['Драма', 'Партнёр'] : [];
        const content = reviewMode === 'legacy' ? JSON.stringify({ approved: true }) : JSON.stringify({ checks, unsupportedTags, issues: 'Не назначайте пользователю признание' });
        return { data: { usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{ message: { content } }] } };
      }
      textCalls++;
      textRequests.push({ model: body.model, maxTokens: body.max_tokens, prompt: body.messages.map(m => m.content).join('\n') });
      if (textMode === 'lost' || textMode === 'lostOnce' && textCalls === lostOnceAt) throw new Error('fixture network timeout');
      const theme = JSON.parse(body.messages[1].content).theme;
      return { data: { usage: { prompt_tokens: 1000, completion_tokens: 2000 }, choices: [{ message: { content:
        textMode === 'invalid' ? '{}' : JSON.stringify(cardFixture(theme)) } }] } };
    } };
    if (name === './translate') return { translateText: async text => {
      translationCalls++;
      if (translationFailures > 0) { translationFailures--; throw new Error('fixture translation timeout'); }
      return 'English translation of the complete character field. Source length: ' + text.length;
    } };
    if (name === './kieAi') return {
      KieError: FixtureKieError, isKieTaskId: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(id),
      createKieAvatar: async prompt => {
        imageCalls++; const id = 'fixture_image_' + imageCalls; imageTasks.set(id, { prompt });
        if (imageMode === 'lost') throw new FixtureKieError('lost_response');
        if (imageMode === 'rejected') throw new FixtureKieError('safety', true);
        return id;
      },
      getKieAvatarTask: async id => {
        if (!imageTasks.has(id)) throw new Error('unknown fixture task');
        return { model: 'seedream/5-flash-text-to-image', state: 'success', credits: 3.24, imageUrl: 'https://tempfile.aiquickdraw.com/fixture.png' };
      },
      saveKieImage: async (_url, owner, id) => { saves++; return `/api/character-media/${owner}/${id.replaceAll('-', '').slice(0, 32)}`; },
    };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const target = name.startsWith('@/') ? resolve('src', name.slice(2)) : resolve(dirname(file), name);
      if (target.endsWith('.json')) return JSON.parse(readFileSync(target, 'utf8'));
      const found = [target, target + '.ts', target + '.js'].find(existsSync);
      return load(found);
    }
    return require(name);
  };
  new Function('require','module','exports','process','console',code)(dependency,mod,mod.exports,{env},{log(){}});
  return mod.exports;
}
let checks = 0;
// Defects found by hand in the 2026-10-14 paid batch, reduced to minimal inputs.
async function validatorChecks() {
  const cardLib = load('src/lib/characterGenerationCard.ts'), lib = load('src/lib/characterGenerationChecks.ts');
  const theme = JSON.parse(readFileSync('src/lib/data/character-generation-themes.json','utf8')).find(t => t.key === 'mafia-heir-with-an-exit');
  const valid = cardFixture(theme), run = card => { try { return cardLib.validateGenerationCard(JSON.stringify(card), theme.key); } catch (error) { return error.message; } };
  check(typeof run(valid) === 'object', 'complete fixture card passes the stricter validator');
  const thin = run({ ...valid, scenario: 'Коротко.', rpConfig: { ...valid.rpConfig, world: 'Город.' } });
  check(typeof thin === 'string' && thin.includes('scenario (от 80 символов)') && !thin.includes('greeting'),
    'validator names the fields that are missing or too short');
  const thinRp = run({ ...valid, rpConfig: { ...valid.rpConfig, world: 'Город.', motivations: '' } });
  check(typeof thinRp === 'string' && thinRp.includes('rpConfig.world') && thinRp.includes('rpConfig.motivations') && !thinRp.includes('rpConfig.speechStyle'),
    'validator lists every thin roleplay setting by name');
  const directions = run({ ...valid, exampleDialogs: '{{user}}: Привет.\n' + theme.name.split(' ')[0]
    + ' (поднимает взгляд): Здравствуйте, рада видеть.\nОна откладывает карту.\n{{user}} (тихо): Что дальше?\n{{char}} (улыбается): Решать вам, я подожду ответа.' });
  check(typeof directions === 'object' && directions.exampleDialogs.split('\n').filter(line => /^\{\{(user|char)\}\}: /.test(line)).length === 4
    && directions.exampleDialogs.includes('{{char}}: (поднимает взгляд) Здравствуйте'),
    'labels with stage directions become markers and continuation lines are kept');
  let brokenJson; try { cardLib.validateGenerationCard('{"name": "Обрыв', theme.key); } catch (error) { brokenJson = error; }
  check(brokenJson?.constructor?.name === 'ClientInputError' && brokenJson.message.includes('JSON'),
    'truncated JSON becomes a format correction for the primary model');
  const repaired = run({ ...valid, tags: ['Романтика', 'Магия', 'Romance', 'Драма', 'Средневековье', 'Мужской персонаж'],
    description: valid.description + ' После перестрелки он прячет архив.',
    exampleDialogs: '{{user}} — Почему?\n{{char}} — ' + 'Потому что так безопаснее для всех. '.repeat(3) + '\n{{user}}: Что дальше?\n' + theme.name + ': Решать вам.' });
  check(repaired.tags === 'Романтика, Драма, Мужской персонаж'
    && repaired.exampleDialogs.split('\n').every(line => /^\{\{(user|char)\}\}: /.test(line)),
    'array, legacy, alias and unsupported setting tags and speaker labels are repaired without a paid retry');
  const reject = (patch, needle, label) => { const message = run({ ...valid, ...patch });
    check(typeof message === 'string' && message.includes(needle), label); };
  reject({ greeting: valid.greeting + ' Подпись: [Имя].' }, '[Имя]', 'placeholder is rejected with its fragment');
  reject({ description: valid.description + ' Высококачественная детализация.' }, 'качестве изображения', 'image-quality jargon outside avatarPrompt is rejected');
  reject({ rpConfig: { ...valid.rpConfig, speechStyle: valid.rpConfig.speechStyle + ' Говорит намёками, намёками.' } }, 'намёками, намёками', 'repeated word is rejected');
  reject({ avatarPrompt: 'Adult man, dark brown eyes, short beard, black suit, dim library with antique shelves, portrait.' }, 'Цвет глаз', 'eye colour mismatch with avatarPrompt is rejected');
  reject({ appearance: valid.appearance.replace('33 лет', 'лет тридцати') }, '33 года', 'theme age must be written in digits in appearance');
  reject({ rpConfig: { ...valid.rpConfig, canonicalNotes: 'Отец жив. ' + valid.rpConfig.canonicalNotes } }, 'Возраст: N', 'canonical notes must open with the age');
  reject({ exampleDialogs: valid.exampleDialogs.replace('{{char}}: ', '{{char}}: Я скажу, что ты ворвалась в мою жизнь. ') }, 'ты … ворвалась', 'gendered address to the user is rejected');
  reject({ exampleDialogs: valid.exampleDialogs.replace('{{user}}: Почему', '{{user}}: Я просто нашёл его. Почему') }, 'я … нашёл', 'gendered user line is rejected');
  check(!lib.userGenderFragments({ greeting: 'Вы пришли вовремя.', exampleDialogs: '{{user}}: Ты знал, кто я, когда писал?\n{{char}}: Знал. Вы уверены?' }).length,
    "neutral address and the character's own past tense are not flagged");
  check(lib.alignNameTranslation('Silvan Rey opened the door. Say nothing, Ray.', 'Sylvan Ray') === 'Sylvan Ray opened the door. Say nothing, Ray.',
    'English name variants follow name_en without touching other words');
  check(lib.transliterateName('Руна Север') === 'Runa Sever' && lib.transliterateName('Демьян Лесной') === 'Demyan Lesnoy'
    && lib.transliterateName('Артём Серов') === 'Artyom Serov' && lib.transliterateName('ЭХО-7') === 'EKHO-7',
    'names are transliterated, not translated');
  check(lib.transliterateName('Кэйдзи Арасэ') === 'Keiji Arase' && lib.transliterateName('Рё Камидзё') === 'Ryo Kamijo'
    && lib.transliterateName('Кайто Мацуда') === 'Kaito Matsuda' && lib.transliterateName('Арсений Вельский') === 'Arseny Velsky'
    && lib.transliterateName('Ксения Лаврова') === 'Ksenia Lavrova' && lib.transliterateName('Василиса Берест') === 'Vasilisa Berest',
    'Japanese names use Hepburn and Russian endings use common English spellings');
  const guard = lib.protectName('Глаза Руны светятся. Стая ждёт Руну Север. Северный ветер.', 'Руна Север');
  check(guard.text === 'Глаза ZXQ0 светятся. Стая ждёт ZXQ0 ZXQ1. Северный ветер.'
    && guard.intact('The eyes of the ZXQ0 glow. The pack is waiting for zxq0 ZXQ1. The northern wind.')
    && guard.restore('The eyes of the ZXQ0 glow. The pack is waiting for zxq0 ZXQ1. The northern wind.') === 'The eyes of Runa glow. The pack is waiting for Runa Sever. The northern wind.'
    && !guard.intact('The eyes of the rune glow. The pack is waiting for ZXQ0 ZXQ1.'),
    'inflected name forms are kept out of translation and a dropped token is detected');
  check(lib.fixAppearancePronouns('Her eyes are grey. On her feet are boots. A mark on your left arm. I always have a notebook.',
    'Мужчина 32 лет. Глаза серые. На ногах ботинки. Метка на левой руке, светится при приближении к вам. Всегда с собой блокнот.', 'male')
    === 'His eyes are grey. On his feet are boots. A mark on his left arm. He always has a notebook.'
    && lib.fixAppearancePronouns('His eyes are grey. He wears a shirt.', '30 лет. Глаза серые. Носит рубашку.', 'female') === 'Her eyes are grey. She wears a shirt.'
    && lib.fixAppearancePronouns('Her father looks at her.', 'Её отец смотрит на неё.', 'female') === 'Her father looks at her.',
    'appearance pronouns follow the character gender unless another person is described');
  const anime = jobs.batchAvatarPrompt({ ...valid, avatarPrompt: 'A man in a dimly lit corridor, photorealistic, cinematic lighting, 8k resolution.' }, 'building-mage-missing-floor');
  const real = jobs.batchAvatarPrompt({ ...valid, avatarPrompt: 'A man in a dimly lit corridor, muted tones, hyperrealistic, 8k.' }, theme.key);
  check(anime.startsWith('Anime illustration') && real.startsWith('Photorealistic portrait')
    && ![anime, real].some(p => /photorealistic,|8k|dimly lit|muted tones|hyperrealistic/i.test(p)) && [anime, real].every(p => p.includes('Lively, engaged')),
    'batch avatars use the theme style, drop style and gloom words and ask for a lively, lit face');
  check(real.includes('Bright natural daylight') && !anime.includes('Bright natural daylight')
    && !/long shadows|low-light/i.test(jobs.batchAvatarPrompt({ ...valid, avatarPrompt: 'A room in low-light, a lamp casts long shadows on the desk and the wall.' }, theme.key)),
    'realistic batch avatars ask for daylight and lose shadowy scene words');
  check(lib.characterGender({ tags: 'Фэнтези, Наставник', appearance: 'Рэн Асаи, 41 год. Длинные чёрные волосы. На нём простая куртка. Он держится прямо.' }) === 'male'
    && lib.characterGender({ tags: 'Фэнтези', appearance: 'Высокая, коротко стриженная. На ней кремовая блуза, её взгляд пристальный.' }) === 'female'
    && lib.characterGender({ tags: 'Фэнтези', appearance: 'Высокий рост. Его сестра держит её за руку.' }) === null
    && lib.fixAppearancePronouns('Her long black hair is tied up. He wears a jacket.', 'Длинные чёрные волосы. На нём простая куртка. Он держится прямо.',
      lib.characterGender({ tags: '', appearance: 'Длинные чёрные волосы. На нём простая куртка. Он держится прямо.' })) === 'His long black hair is tied up. He wears a jacket.',
    'gender comes from Russian pronouns when the card has no gender tag');
  check(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].every(seed => !/синевой под глазами|тяжёлые веки/.test(cardLib.lookTraits(seed).join())),
    'distinctive features never ask for a tired or sickly face');
  check(jobs.withStyleTag('Фэнтези, Комедия, Сосед', 'building-mage-missing-floor') === 'Фэнтези, Комедия, Сосед, Аниме'
    && jobs.withStyleTag('Фэнтези, Комедия, Сосед', theme.key) === 'Фэнтези, Комедия, Сосед',
    'anime cards get the catalogue style tag');
  check(textRequests.some(r => r.prompt.includes('Чтобы лица в каталоге различались')) && cardLib.lookTraits('a').join() === cardLib.lookTraits('a').join()
    && new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(seed => cardLib.lookTraits(seed).join())).size > 3,
    'each job asks for its own stable set of distinctive features');
  const warnings = lib.translationWarnings({ ...valid, tags: 'Мужской персонаж' }, { appearance_en: 'An adult of thirty. Her movements are calm.',
    exampleDialogs_en: 'user: Why?' });
  check(warnings.some(w => w.includes('33')) && warnings.some(w => w.includes('женские местоимения')) && warnings.some(w => w.includes('маркеры')),
    'translation warnings flag lost ages, wrong pronouns and lost speaker markers');
}
const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const req = (body, secret = 'fixture_admin') => new NextRequest('https://example.test/api/admin/character-generation', {
  method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + secret }, ...(body ? { body: JSON.stringify(body) } : {}) });
let jobs, admin, cron;
async function accelerate() { await db.characterGenerationItem.updateMany({ data: { nextRunAt: new Date() } }); }
async function drain(batch, max = 200) {
  for (let i=0; i<max; i++) {
    await accelerate(); await jobs.processGenerationStep();
    const current = await db.characterGenerationBatch.findUnique({ where: { id: batch.id } });
    if (current.state !== 'running') return current;
  }
  throw new Error('Fixture batch did not finish');
}
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_character_generation_test'); await ddl.connect();
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','db','push','--skip-generate','--schema',schema],
    { env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  assert.equal(setup.status, 0, 'isolated schema setup');
  const owner = await db.user.create({ data: { email: 'generation@example.test', tokensUsedThisMonth: 3 } });
  ownerId = sessionOwner = owner.id;
  await db.character.create({ data: { name: 'Existing fixture card', userId: ownerId, isPublic: true } });
  await ddl.query('DROP TABLE "CharacterGenerationAttempt", "CharacterGenerationItem", "CharacterGenerationBatch"');
  await ddl.query(`CREATE TABLE "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  const migrate = () => spawnSync(process.execPath, ['scripts/apply-character-generation-migration.mjs'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(migrate().status, 0, 'feature migration installer');
  assert.equal(migrate().status, 0, 'feature migration replay');
  check(await db.character.count() === 1, 'additive migration preserves existing characters');
  check((await ddl.query('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"')).rows[0].count === 1,
    'migration installer records one checksum and tolerates replay');
  jobs = load('src/lib/characterGeneration.ts'); admin = load('src/app/api/admin/character-generation/route.ts');
  cron = load('src/app/api/cron/generate-characters/route.ts');
  check((await admin.GET(req(null, 'wrong'))).status === 401, 'admin secret required for reads');
  sessionOwner = null;
  check((await admin.POST(req({ action:'start',clientKey:randomUUID(),count:1,budgetRub:200 }))).status === 401, 'admin secret does not replace owner login');
  sessionOwner = ownerId;
  check(!(await jobs.generationStatus(ownerId)).workerEnabled, 'dev or direct startup never claims an internal worker is active');
  env.CHARACTER_GENERATION_WORKER_ACTIVE = '1';
  check((await jobs.generationStatus(ownerId)).workerEnabled, 'production wrapper announces the configured background worker');
  check((await cron.POST(req({}, 'wrong'))).status === 401, 'background endpoint requires cron secret');
  const key = randomUUID();
  const first = await jobs.createGenerationBatch(ownerId,key,10,200);
  const replay = await jobs.createGenerationBatch(ownerId,key,10,200);
  check(first.id === replay.id && await db.characterGenerationItem.count({where:{batchId:first.id}}) === 10, 'replayed start creates one party and ten jobs');
  const pause = await jobs.controlGenerationBatch(ownerId, first.id, 'pause');
  const priorCalls = textCalls;
  check(pause.state === 'paused' && !(await jobs.processGenerationStep()).processed && textCalls === priorCalls, 'pause prevents new paid work');
  await jobs.controlGenerationBatch(ownerId,first.id,'resume');
  const golden = await drain(first);
  check(golden.state === 'completed', 'all ten cards finish without browser polling');
  const ready = await db.characterGenerationItem.findMany({where:{batchId:first.id},orderBy:{position:'asc'}});
  const cards = await db.character.findMany({where:{id:{in:ready.map(i=>i.characterId)}}});
  check(cards.length === 10 && cards.every(c=>!c.isPublic && c.imageUrl.startsWith('/api/character-media/') && c.name_en && c.greeting_en),
    'ten private drafts contain storage links and complete English fields');
  const translit = load('src/lib/characterGenerationChecks.ts').transliterateName;
  check(cards.every(c => c.name_en === translit(c.name) && c.artStyle === 'realistic')
    && [...imageTasks.values()].slice(0, 10).every(task => task.prompt.startsWith('Photorealistic portrait') && task.prompt.includes('Lively, engaged')),
    'drafts get transliterated English names and realistic themes keep the realistic style');
  check(imageCalls === 10 && saves === 10 && await db.avatarQuotaReservation.count() === 0
    && (await db.user.findUnique({where:{id:ownerId}})).tokensUsedThisMonth === 3, 'catalog generation does not consume user avatar quota');
  check(golden.spentKopecks + golden.reservedKopecks <= 20000 && golden.reservedKopecks === 0, 'settled costs stay within batch ceiling');
  const noChangeCount = await db.character.count();
  await jobs.processGenerationStep();
  check(await db.character.count() === noChangeCount && imageCalls === 10, 'finished jobs never create duplicate characters or paid tasks');
  await jobs.controlGenerationBatch(ownerId, first.id, 'publish', ready[0].id);
  check((await db.character.findUnique({where:{id:ready[0].characterId}})).isPublic, 'reviewed draft can be published explicitly');
  check((await jobs.generationStatus(ownerId)).batches.find(b=>b.id===first.id).items[0].isPublic,
    'admin status reflects publication');
  const other = await db.user.create({data:{email:'other@example.test'}});
  await assert.rejects(jobs.controlGenerationBatch(other.id,first.id,'publish',ready[1].id));
  check(true, 'another owner cannot publish or control a batch');
  await db.character.update({where:{id:ready[0].characterId},data:{isPublic:false}});
  // The next party takes the first unused theme; its name is already public and must fail before images.
  const allThemes = JSON.parse(readFileSync('src/lib/data/character-generation-themes.json','utf8'));
  await db.character.create({ data: { name: allThemes[10].name, descriptionCard: allThemes[10].premise, userId: other.id, isPublic: true } });
  const nextTheme = (await jobs.generationStatus(ownerId)).themes[0].key;
  const duplicates = await jobs.createGenerationBatch(ownerId,randomUUID(),1,200);
  check(nextTheme === allThemes[10].key && (await db.characterGenerationItem.findFirst({where:{batchId:duplicates.id}})).themeKey === nextTheme
    && (await jobs.generationStatus(ownerId)).themes[0].key === allThemes[11].key,
    'a new party skips themes that already produced drafts or are queued');
  const beforeDuplicateImages=imageCalls, beforeDuplicateTexts=textRequests.length; await drain(duplicates);
  const duplicateItem = await db.characterGenerationItem.findFirst({where:{batchId:duplicates.id}});
  check(imageCalls === beforeDuplicateImages && duplicateItem.state === 'failed' && duplicateItem.errorCode === 'duplicate'
    && duplicateItem.feedback.includes(`«${allThemes[10].name}»`),
    'a similar card is rejected before avatar payment and the reason names the existing character');
  const duplicatePrompts = textRequests.slice(beforeDuplicateTexts);
  check(duplicatePrompts.length === 2 && duplicatePrompts.every(r => r.prompt.includes(`Имя «${allThemes[10].name}»`)
    && !JSON.parse(r.prompt.split('\n').find(line => line.startsWith('{"theme"'))).theme.name),
    'a taken theme name is withheld from the prompt and named as forbidden');
  // Use a separate owner to avoid interference from deliberately duplicated concepts.
  ownerId = sessionOwner = other.id;
  const low = await jobs.createGenerationBatch(ownerId,randomUUID(),1,1);
  const beforeLow=imageCalls; const lowResult=await drain(low);
  check(imageCalls===beforeLow && lowResult.spentKopecks+lowResult.reservedKopecks<=100
    && (await db.characterGenerationItem.findFirst({where:{batchId:low.id}})).errorCode==='budget', 'small budget stops before avatar payment without overspending');
  const lost = await jobs.createGenerationBatch(ownerId,randomUUID(),1,200); imageMode='lost';
  await drain(lost); const uncertain=await db.characterGenerationItem.findFirst({where:{batchId:lost.id}});
  const lostCalls=imageCalls;
  check(uncertain.state==='uncertain' && uncertain.errorCode==='image_uncertain', 'lost image-create response becomes durable attention state');
  await assert.rejects(jobs.controlGenerationBatch(ownerId,lost.id,'retry',uncertain.id));
  await jobs.processGenerationStep();
  check(imageCalls===lostCalls, 'unknown paid image is never automatically submitted again');
  imageMode='ok';
  await jobs.controlGenerationBatch(ownerId,lost.id,'recover',uncertain.id,'fixture_image_'+imageCalls);
  await drain(lost);
  check(imageCalls===lostCalls && (await db.characterGenerationItem.findUnique({where:{id:uncertain.id}})).state==='ready', 'recovering provider task reuses paid result');
  // Simulate process death after a reservation, before the response checkpoint.
  const staleOwner=await db.user.create({data:{email:'stale@example.test'}});
  const stale=await jobs.createGenerationBatch(staleOwner.id,randomUUID(),1,200);
  const staleItem=await db.characterGenerationItem.findFirst({where:{batchId:stale.id}});
  await db.characterGenerationItem.update({where:{id:staleItem.id},data:{leaseToken:'dead_worker',leaseUntil:new Date(Date.now()-1000)}});
  await db.characterGenerationAttempt.create({data:{id:randomUUID(),itemId:staleItem.id,stage:'text',number:1,reservedKopecks:100}});
  await db.characterGenerationBatch.update({where:{id:stale.id},data:{reservedKopecks:100}});
  await jobs.processGenerationStep();
  check((await db.characterGenerationAttempt.findFirst({where:{itemId:staleItem.id,number:1}})).state==='uncertain', 'restart retains cost of interrupted text attempt');
  await jobs.controlGenerationBatch(staleOwner.id,stale.id,'pause');
  const brokenOwner=await db.user.create({data:{email:'broken@example.test'}});
  const broken=await jobs.createGenerationBatch(brokenOwner.id,randomUUID(),1,200); textMode='invalid';
  await drain(broken); textMode='ok';
  check(await db.characterGenerationAttempt.count({where:{item:{batchId:broken.id},stage:'text'}})===2
    && (await db.characterGenerationItem.findFirst({where:{batchId:broken.id}})).state==='failed', 'invalid card retries at most twice');
  check(!(await jobs.generationStatus(brokenOwner.id)).batches[0].items[0].canRetry,
    'exhausted stages do not offer another paid retry');
  check(textRequests.at(-2).model==='Qwen/Qwen3-235B-A22B-Instruct-2507'
    && textRequests.at(-1).model==='Qwen/Qwen3-235B-A22B-Instruct-2507',
    'validation feedback retries the primary model instead of the weaker fallback');
  const lostOwner=await db.user.create({data:{email:'lost-text@example.test'}});
  const lostText=await jobs.createGenerationBatch(lostOwner.id,randomUUID(),1,200); textMode='lostOnce'; lostOnceAt=textCalls+1;
  await drain(lostText); textMode='ok';
  check(textRequests.at(-2).model==='Qwen/Qwen3-235B-A22B-Instruct-2507'
    && textRequests.at(-1).model==='mistralai/Mistral-Small-3.2-24B-Instruct-2506' && textRequests.at(-1).maxTokens===3200
    && (await db.characterGenerationItem.findFirst({where:{batchId:lostText.id}})).state==='ready',
    'a failed text request switches to the bounded fallback model');
  const brokenItem=await db.characterGenerationItem.findFirst({where:{batchId:broken.id}});
  const chargedBeforeRepair=(await db.characterGenerationBatch.findUnique({where:{id:broken.id}})).spentKopecks;
  await jobs.controlGenerationBatch(brokenOwner.id,broken.id,'pause');
  const beforeRepairCalls=textCalls;
  await jobs.controlGenerationBatch(brokenOwner.id,broken.id,'repair',brokenItem.id);
  check((await db.characterGenerationBatch.findUnique({where:{id:broken.id}})).state==='paused'
    && textCalls===beforeRepairCalls, 'manual repair preserves pause and starts no paid request itself');
  await assert.rejects(jobs.controlGenerationBatch(brokenOwner.id,broken.id,'repair',brokenItem.id));
  await jobs.controlGenerationBatch(brokenOwner.id,broken.id,'resume');await drain(broken);
  check((await db.characterGenerationItem.findUnique({where:{id:brokenItem.id}})).state==='ready'
    && await db.characterGenerationAttempt.count({where:{itemId:brokenItem.id,stage:'text'}})===2
    && await db.characterGenerationAttempt.count({where:{itemId:brokenItem.id,stage:'text_repair'}})===1
    && (await db.characterGenerationBatch.findUnique({where:{id:broken.id}})).spentKopecks>=chargedBeforeRepair,
    'manual repair creates a draft without erasing previous paid attempts');
  await assert.rejects(jobs.controlGenerationBatch(brokenOwner.id,broken.id,'repair',brokenItem.id));
  const repairOwner=await db.user.create({data:{email:'repair-exhaustion@example.test'}});
  const exhaustedRepair=await jobs.createGenerationBatch(repairOwner.id,randomUUID(),1,200);textMode='invalid';await drain(exhaustedRepair);
  const repairItem=await db.characterGenerationItem.findFirst({where:{batchId:exhaustedRepair.id}});
  await jobs.controlGenerationBatch(repairOwner.id,exhaustedRepair.id,'repair',repairItem.id);await drain(exhaustedRepair);textMode='ok';
  check(await db.characterGenerationAttempt.count({where:{itemId:repairItem.id,stage:'text_repair'}})===2
    && !(await jobs.generationStatus(repairOwner.id)).batches[0].items[0].canRepair,
    'one manual repair round is bounded to two requests');
  await assert.rejects(jobs.controlGenerationBatch(repairOwner.id,exhaustedRepair.id,'repair',repairItem.id));
  const translateOwner=await db.user.create({data:{email:'translation@example.test'}});
  const partial=await jobs.createGenerationBatch(translateOwner.id,randomUUID(),1,200);
  for(let i=0;i<6;i++){await accelerate();await jobs.processGenerationStep();}
  const partialItem=await db.characterGenerationItem.findFirst({where:{batchId:partial.id}});
  const alreadyTranslated=Object.keys(partialItem.translations??{});
  translationFailures=1; await accelerate();await jobs.processGenerationStep();
  await drain(partial);
  const partialDone=await db.characterGenerationItem.findUnique({where:{id:partialItem.id}});
  check(alreadyTranslated.length>0 && partialDone.state==='ready' && alreadyTranslated.every(k=>partialDone.translations[k]===partialItem.translations[k]),
    'translation retry keeps previously saved English fields');
  const concurrentOwner=await db.user.create({data:{email:'concurrent@example.test'}});
  const concurrent=await jobs.createGenerationBatch(concurrentOwner.id,randomUUID(),3,6);
  const concurrencyBefore=textCalls;
  await accelerate(); await Promise.all([jobs.processGenerationStep(),jobs.processGenerationStep(),jobs.processGenerationStep(),jobs.processGenerationStep()]);
  const concurrentCosts=await db.characterGenerationBatch.findUnique({where:{id:concurrent.id}});
  check(concurrentCosts.spentKopecks+concurrentCosts.reservedKopecks<=600 && textCalls-concurrencyBefore<=3, 'concurrent workers cannot overspend shared ceiling');
  await jobs.controlGenerationBatch(concurrentOwner.id,concurrent.id,'pause');
  const reviewOwner=await db.user.create({data:{email:'review@example.test'}});
  const rejected=await jobs.createGenerationBatch(reviewOwner.id,randomUUID(),1,200); reviewMode='reject';
  const priorImages=imageCalls; await drain(rejected); reviewMode='ok';
  const rejectedItem=await db.characterGenerationItem.findFirst({where:{batchId:rejected.id}});
  check(imageCalls===priorImages && rejectedItem.state==='failed' && rejectedItem.feedback.startsWith('Не выполнено: userAgency'),
    'semantic rejection names the failed checklist item and repairs text before paying for an avatar');
  check((await jobs.generationStatus(reviewOwner.id)).batches[0].items[0].feedback === rejectedItem.feedback
    && (await jobs.generationStatus(ownerId)).batches.every(b => b.items.every(i => i.state === 'failed' || i.feedback === null)),
    'admin status shows the rejection reason only for failed cards');
  check(reviewRequests.length>0 && reviewRequests.every(r=>r.model==='Qwen/Qwen3-235B-A22B-Instruct-2507' && r.system.includes('userGender') && r.system.includes('timeline')
    && r.system.includes('Многоточие') && r.system.includes('допустимы в avatarPrompt')),
    'consistency review uses the primary model with the full checklist');
  const legacyOwner=await db.user.create({data:{email:'legacy-review@example.test'}});
  const legacy=await jobs.createGenerationBatch(legacyOwner.id,randomUUID(),1,200); reviewMode='legacy';
  const legacyImages=imageCalls; await drain(legacy); reviewMode='ok';
  check(imageCalls===legacyImages && (await db.characterGenerationItem.findFirst({where:{batchId:legacy.id}})).errorCode==='review_failed',
    'a bare approval without checklist is not accepted');
  for (const [mode, expected] of [['dropTag', 'ready'], ['dropMany', 'failed']]) {
    const tagOwner = await db.user.create({ data: { email: `tags-${mode}@example.test` } });
    const tagBatch = await jobs.createGenerationBatch(tagOwner.id, randomUUID(), 1, 200); reviewMode = mode;
    await drain(tagBatch); reviewMode = 'ok';
    const tagItem = await db.characterGenerationItem.findFirst({ where: { batchId: tagBatch.id }, include: { character: true } });
    check(tagItem.state === expected && (expected === 'ready'
      ? tagItem.character.tags === 'Романтика, Партнёр, Медленное развитие отношений'
      : tagItem.feedback.startsWith('Не выполнено: tags') && tagItem.feedback.includes('меньше 3 тегов')),
      mode === 'dropTag' ? 'an unsupported tag is removed instead of rejecting the card' : 'a card left with fewer than three supported tags is sent back for repair');
  }
  await validatorChecks();
  let ticks=0, seenAuth;
  const worker=startCharacterGenerationWorker({port:'3456',secret:'fixture_cron',intervalMs:2,fetchImpl:async(url,init)=>{
    assert.equal(url,'http://127.0.0.1:3456/api/cron/generate-characters'); ticks++;seenAuth=init.headers.Authorization; return Response.json({processed:false}); }});
  await new Promise(done=>setTimeout(done,30)); worker.stop(); const stopped=ticks;
  await new Promise(done=>setTimeout(done,20));
  check(stopped>0 && ticks===stopped && seenAuth==='Bearer fixture_cron', 'server worker polls authenticated loopback and stops cleanly');
  const beforeRead=textCalls+imageCalls+translationCalls; sessionOwner=other.id;
  check((await admin.GET(req())).status===200 && textCalls+imageCalls+translationCalls===beforeRead, 'status reads never perform paid work');
  check(!JSON.stringify(logs).includes('fixture_admin')&&!JSON.stringify(logs).includes('fixture_cron'), 'logs contain no administrative credentials');
  writeFileSync('docs/character-generation-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),checks,
    mode:'Disposable PostgreSQL; actual worker/admin routes; simulated paid providers and storage',paidCalls:0,productionDatabaseAccess:false},null,2)+'\n');
  console.log(`Character generation: ${checks} checks passed. No paid calls or production DB access.`);
} finally {
  await db.$disconnect(); await ddl.end();
  if(process.platform==='win32'&&pg.process){const child=pg.process;
    assert.equal(resolve(child.spawnargs[child.spawnargs.indexOf('-D')+1]),resolve(join(directory,'db')));
    const closed=new Promise(done=>child.once('close',done));
    const stop=spawnSync(join(dirname(child.spawnfile),'pg_ctl.exe'),['stop','-D',join(directory,'db'),'-m','fast','-w','-t','15'],
      {encoding:'utf8',windowsHide:true,timeout:20000}); assert.equal(stop.status,0);await closed;pg.process=undefined;
  }else await pg.stop();
}
