import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { moduleLoader } from './lib/load-local-module.mjs';

const load = moduleLoader();
const { formatChatMessage, withoutChatThoughts } = load('src/lib/chatMessageMarkup.ts');
const { speechSource } = load('src/lib/speech.ts');
const { assembleRoleplayPrompt, withTurnReminder } = load('src/lib/chatSystemPrompt.ts');
const { factSources } = load('src/lib/memoryFacts.ts');
const { makeSummarySources } = load('src/lib/memorySummaryEvidence.ts');
const { formatRagLine } = load('src/lib/ragRetrieval.ts');
const { storyAmbience } = load('src/lib/storyAmbience.ts');
const thought = 'class="text-wd-secondary"';
const action = 'class="text-wd-story-muted"';

assert.equal(formatChatMessage("*I step back.* 'I don't trust him.' Who's there?"),
  `<em ${action}>I step back.</em> <em ${thought}>I don't trust him.</em> Who's there?`);
assert.equal(formatChatMessage('‘I can’t let them in.’'), `<em ${thought}>I can’t let them in.</em>`);
assert.equal(formatChatMessage("'Waiting *quietly* <script> & watching.'"),
  `<em ${thought}>Waiting &#42;quietly&#42; &lt;script&gt; &amp; watching.</em>`);
assert.equal(formatChatMessage("«На табличке написано 'закрыто'.»\nНе знаю 'почему"),
  "«На табличке написано 'закрыто'.»<br />Не знаю 'почему");
assert.equal(speechSource("За окном шёл дождь. 'Я боюсь.' «Я останусь»."), 'За окном шёл дождь.   «Я останусь».');
assert.equal(speechSource("'Только мысль.'"), '');
assert.equal(speechSource("O'Neil said: \"'Please wait' is on the sign.\""), "O'Neil said: \"'Please wait' is on the sign.\"");
assert.equal(withoutChatThoughts("'First thought.' 'Second thought.' I won't speak."), "    I won't speak.");
for (const stars of ['*', '**', '***']) assert.equal(formatChatMessage(`${stars}действие${stars}`), `<em ${action}>действие</em>`);

const manifest = JSON.parse(readFileSync('public/locales/manifest.json', 'utf8'));
for (const [locale, settings] of Object.entries(manifest.locales)) {
  if (!settings.enabled) continue;
  const { example } = JSON.parse(readFileSync(`public/locales/${locale}/common.json`, 'utf8')).chatGuide;
  assert.match(formatChatMessage(example), /text-wd-story-muted[^>]*>[^<]+<\/em> <em class="text-wd-secondary">[^<]+<\/em> \S/u, locale);
}
const secret = { id: 'user-turn', role: 'user', content: "'Рассказчик, где мои монеты?' Открываю дверь." };
const hiddenIntent = withTurnReminder([secret], 'ru')[0].content;
assert.match(hiddenIntent, /^'…' Открываю дверь\./u);
assert.doesNotMatch(hiddenIntent, /где мои монеты/u);
assert.doesNotMatch(hiddenIntent, /Деньги называй числом|Пользователь обратился к рассказчику вне сцены/u);
assert.match(hiddenIntent, /добавь одну его короткую внутреннюю фразу/u);
assert.equal(withTurnReminder([secret, { role: 'assistant', content: 'Входите.' }], 'ru')[0].content, "'…' Открываю дверь.");
const narratorTurn = withTurnReminder([{ role: 'user', content: "'Я не помню.' Рассказчик, кто меня нанял?" }], 'ru')[0].content;
assert.match(narratorTurn, /Пользователь обратился к рассказчику вне сцены/u);
assert.doesNotMatch(narratorTurn, /добавь одну его короткую внутреннюю фразу/u);
assert.doesNotMatch(withTurnReminder([{ role: 'user', content: 'Кто здесь?' }], 'ru')[0].content, /добавь одну его короткую внутреннюю фразу/u);
assert.equal(factSources([secret])[0].text, 'Открываю дверь.');
assert.equal(makeSummarySources([secret])[0].text, 'Открываю дверь.');
assert.equal(formatRagLine(secret, 'ru'), '- Пользователь: Открываю дверь.');
assert.equal(storyAmbience([{ role: 'assistant', content: "'На улице идёт дождь.'" }]), null);
console.log('PASS thought formatting, speech exclusion, localized guides, private turn intent and memory sources');

if (process.argv.includes('--live')) await verifyLive();

async function verifyLive() {
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
  const { DEEPINFRA_CHAT_URL, providerApiKey } = load('src/lib/aiProviders.ts');
  const { deepinfraFetch } = load('src/lib/deepinfraNetwork.ts');
  const { chatModelGenerationOptions } = load('src/lib/testingChatModels.ts');
  const key = providerApiKey('deepinfra');
  const models = ['google/gemma-4-31B-it-turbo', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'Qwen/Qwen3-Next-80B-A3B-Instruct'];
  const cases = [
    {
      id: 'character-ru', locale: 'ru', mode: 'character',
      profile: { name: 'Мира', description: 'Стражница. Она узнала печать на чужом письме и скрывает это. В сценах с печатью читателю показывается её короткая внутренняя реакция, пока вслух она говорит сдержанно.' },
      turn: "*Кладу письмо на стол.* 'Лазурный ключ спрятан у меня в сапоге.' Вы узнаёте эту печать?",
      privateDetail: /лазурн|сапог/iu,
    },
    {
      id: 'group-ru', locale: 'ru', mode: 'group',
      profile: { name: 'Дозор на мосту', description: 'Яна — капитан, тревожится о потайном проходе, который знает одна. Лев — дозорный, который видит только мост. Покажи читателю одну короткую внутреннюю реакцию Яны, а в разговоре пусть персонажи сохраняют свои знания.' },
      turn: "*Подхожу к Яне и Льву.* 'Я оставил пурпурный компас у мельницы.' У моста безопасно?",
      privateDetail: /пурпурн|компас|мельниц/iu,
    },
    {
      id: 'world-en', locale: 'en', mode: 'world',
      profile: { name: 'Last train', description: 'Rain falls on the station. Nell is the ticket clerk. A glimpse of her private worry about closing the station gives the scene tension; she still answers ordinary questions aloud.' },
      turn: "*I hand Nell my ticket.* 'I don't want her to find the violet telescope in my bag.' When does the last train leave?",
      privateDetail: /violet|telescope/iu,
    },
    {
      id: 'group-en-legacy', locale: 'en', mode: 'group',
      profile: { name: 'The archive', description: 'Ren guards a library with Ada. Ren privately recognizes the wax seal and keeps that reaction from Ada. Keep the scene short, with one private reaction from Ren, an observable gesture, and an answer aloud.' },
      previous: '*Ren looked at Ada and thought she should leave.* The library closes soon.',
      turn: "*I put the sealed letter between them.* 'I won't tell them the cinder map is mine.' Who can read the seal?",
      privateDetail: /\bcinder\b|\bmap\b/iu,
    },
  ];
  let failed = 0;
  await Promise.all(models.map(async model => {
    for (const entry of cases) {
      const { locale, mode, profile, turn, previous, privateDetail, id } = entry;
      const messages = withTurnReminder([
        { role: 'system', content: assembleRoleplayPrompt(profile, locale, { mode }).content },
        ...(previous ? [{ role: 'assistant', content: previous }] : []),
        { role: 'user', content: turn },
      ], locale);
      try {
        const response = await deepinfraFetch(DEEPINFRA_CHAT_URL, { method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, ...chatModelGenerationOptions(`deepinfra:${model}`) }),
          signal: AbortSignal.timeout(55_000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          failed++;
          console.log(JSON.stringify({ model, id, error: `HTTP ${response.status}` }));
          continue;
        }
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
        const actionSpans = [...reply.matchAll(/(\*{1,3})([^*\n]+?)\1/gu)].map(match => match[2]);
        const outsideActions = reply.replace(/(\*{1,3})([^*\n]+?)\1/gu, ' ');
        const starsInThought = /<em class="text-wd-secondary">[^<]*&#42;/u.test(formatChatMessage(reply));
        const thoughtInAction = starsInThought || actionSpans.some(span => formatChatMessage(span).includes(thought)
          || /подумал|про себя|мысленно|в мыслях|внутренний голос|(?:она|он) (?:знает|знала?|понимает|понимала?)(?!\p{L})|\b(?:thought|inwardly|to (?:him|her|them)self|(?:she|he) (?:knows|knew|wondered))\b/iu.test(span));
        const hasThought = formatChatMessage(outsideActions).includes(thought);
        const hasSeparateText = Boolean(withoutChatThoughts(outsideActions).trim());
        const leaked = privateDetail.test(reply);
        const passed = data.choices?.[0]?.finish_reason === 'stop' && hasThought && hasSeparateText && !thoughtInAction && !leaked;
        if (!passed) failed++;
        console.log(JSON.stringify({ model, id, passed, hasThought, thoughtInAction, leaked, reply }));
      } catch (error) {
        failed++;
        console.log(JSON.stringify({ model, id, error: error.name }));
      }
    }
  }));
  const total = models.length * cases.length;
  console.log(`Live thought checks: ${total - failed}/${total} passed`);
  if (failed) process.exitCode = 1;
}
