// Small paid A/B evaluation with synthetic dialogue only, no application database.
// node scripts/eval-memory-backstory.mjs --paid [--provider deepinfra|kodikrouter] [--out file.json]
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (arg('--replay')) {
  const saved = JSON.parse(readFileSync(arg('--replay'), 'utf8'));
  const { root, load } = createModuleLoader({ prismaFor: () => { throw new Error('Database forbidden'); } });
  const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
  const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));
  for (const row of saved.report.filter(row => row.version === 'after')) {
    const sources = evidence.makeSummarySources(saved.scenarios.find(scenario => scenario.id === row.scenario).messages);
    row.summary = evidence.renderGroundedSummary(row.raw, sources, row.budget, countTokens, stats => { row.diagnostics = stats; });
    console.log(JSON.stringify({ scenario: row.scenario, summary: row.summary, diagnostics: row.diagnostics }));
  }
  saved.renderReplayed = true;
  writeFileSync(arg('--replay'), `${JSON.stringify(saved, null, 2)}\n`);
  process.exit(0);
}
if (!process.argv.includes('--paid')) throw new Error('Live evaluation requires --paid; it calls a paid text provider.');
const config = { ...process.env };
for (const file of ['.env', '.env.local']) if (existsSync(file)) Object.assign(config, parse(readFileSync(file)));
const provider = arg('--provider') ?? config.MEMORY_AI_PROVIDER ?? 'kodikrouter';
if (!['deepinfra', 'kodikrouter'].includes(provider)) throw new Error('Unsupported provider');
const key = provider === 'deepinfra' ? config.DEEPINFRA_API_KEY : config.KODIKROUTER_API_KEY;
if (!key) throw new Error('No key configured for selected provider');
const loaders = [
  ['before', createModuleLoader({ prismaFor: () => { throw new Error('Database forbidden'); }, sourceRef: 'HEAD' })],
  ['after', createModuleLoader({ prismaFor: () => { throw new Error('Database forbidden'); } })],
];
if (process.argv.includes('--after-only')) loaders.shift();
const scenarios = [
  { id: 'search-and-change-of-plan', budget: 800, messages: [
    { role: 'user', content: 'Я пришёл к маяку, чтобы найти пропавшую сестру.' },
    { role: 'assistant', content: 'Сестра оставила записку: она отправилась к северному шлюзу.' },
    { role: 'user', content: 'Я предложил проверить северный шлюз утром.' },
    { role: 'assistant', content: 'Я согласился сопровождать пользователя к северному шлюзу утром.' },
    { role: 'user', content: 'Я отменил поход утром из-за шторма.' },
    { role: 'assistant', content: 'Я нашёл в записке запасной адрес сестры: старая обсерватория.' },
    { role: 'user', content: 'Я решил отправиться в старую обсерваторию после шторма.' },
    { role: 'assistant', content: 'Сестра пока не найдена.' },
  ] },
  { id: 'entry-plan-numbers-and-negation', budget: 200, messages: [
    { role: 'user', content: 'Я передал капитану 2 ключа от маяка.' },
    { role: 'assistant', content: 'Я не нашёл тайник номер 17.' },
    { role: 'user', content: 'Я обещаю помочь персонажу найти тайник номер 17 утром.' },
  ] },
];
const report = [];
for (const scenario of scenarios) for (const [version, { load, root }] of loaders) {
  const evidence = load(join(root, 'src/lib/memorySummaryEvidence.ts'));
  const policy = load(join(root, 'src/lib/memorySummaryPolicy.ts'));
  const { countTokens } = load(join(root, 'src/lib/tokenCount.ts'));
  const sources = evidence.makeSummarySources(scenario.messages);
  const system = 'Ты — суммаризатор ролевых диалогов. Сохрани смысл, действующие планы и изменения состояния по исходной переписке.\n'
    + evidence.GROUNDED_SUMMARY_RULES
    + `\nИтоговая сводка должна поместиться в ${scenario.budget} токенов, включая заголовки и метки. Максимум ${Math.min(10, Math.max(1, Math.floor(scenario.budget / 120)))} пунктов. Текст пунктов — не более ${Math.max(40, scenario.budget - 80)} токенов суммарно. JSON полностью закрой; без markdown-обёртки.`;
  const response = await fetch(provider === 'deepinfra' ? 'https://api.deepinfra.com/v1/openai/chat/completions' : 'https://api.kodikrouter.ru/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: provider === 'deepinfra' ? 'mistralai/Mistral-Small-3.2-24B-Instruct-2506' : 'openai/gpt-4o-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ sources, core: null }) }],
      max_tokens: policy.summaryGenerationLimit(scenario.budget), temperature: 0,
      response_format: provider === 'deepinfra' ? policy.groundedSummaryFormat(sources.map(source => source.id), scenario.budget) : { type: 'json_object' } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const data = await response.json();
  const raw = policy.readSummaryResponse(data).text;
  let diagnostics;
  const summary = evidence.renderGroundedSummary(raw, sources, scenario.budget, countTokens, stats => { diagnostics = stats; });
  report.push({ scenario: scenario.id, version, budget: scenario.budget, raw, summary, diagnostics, usage: data.usage });
  console.log(JSON.stringify({ scenario: scenario.id, version, summary, diagnostics }));
}
if (arg('--out')) writeFileSync(arg('--out'), `${JSON.stringify({ provider, scenarios, report }, null, 2)}\n`);
