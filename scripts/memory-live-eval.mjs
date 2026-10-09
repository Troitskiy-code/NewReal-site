// Paid live evaluation of memory with a real model on an isolated database.
// Spends KodikRouter credit: refuses to run without MEMORY_LIVE_EVAL_CONFIRM=paid and an
// explicit KODIKROUTER_API_KEY in the process environment (.env is never read).
// Run: MEMORY_LIVE_EVAL_CONFIRM=paid KODIKROUTER_API_KEY=... node scripts/memory-live-eval.mjs [--only L1,L4] [--out file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startHarness } from './lib/memory-test-harness.mjs';

if (process.env['MEMORY_LIVE_EVAL_CONFIRM'] !== 'paid') {
  console.error('Refusing: live evaluation calls a paid model. Set MEMORY_LIVE_EVAL_CONFIRM=paid to run it deliberately.');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const argValue = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const only = (argValue('--only') ?? '').split(',').filter(Boolean);
const out = argValue('--out');
const spec = JSON.parse(readFileSync(new URL('../docs/memory-live-scenarios-2026-10-08.json', import.meta.url), 'utf8'));
const h = await startHarness({ label: 'memory-live', realProvider: true });
const report = [];

const lastReply = (turn) => turn.events.find((event) => event.type === 'end')?.assistantMessage?.content ?? '';
const lower = (text) => text.toLowerCase().replace(/ё/g, 'е');

try {
  await h.helpers.model(16_000);
  for (const scenario of spec.scenarios.filter((s) => only.length === 0 || only.includes(s.id))) {
    const user = await h.helpers.user(scenario.plan);
    const character = await h.helpers.character(user.id);
    const transcript = [];
    if (scenario.manualCore) {
      const { NextRequest } = require('next/server');
      const coreRoute = h.load(join(h.root, 'src/app/api/chat/[id]/memory/core/route.ts'));
      h.session.userId = user.id;
      await coreRoute.PUT(new NextRequest(`http://localhost/api/chat/${character.id}/memory/core`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: scenario.manualCore }),
      }), { params: Promise.resolve({ id: character.id }) });
    }
    for (let turnIndex = 1; turnIndex <= scenario.turns; turnIndex += 1) {
      const message = scenario.keyTurns?.[String(turnIndex)] ?? spec.fillers[(turnIndex + scenario.id.length) % spec.fillers.length];
      const turn = await h.chat(user.id, character.id, { message });
      transcript.push({ turn: turnIndex, user: message, reply: lastReply(turn), promptTokens: turn.promptTokens });
    }
    let controlTurn;
    if (scenario.secondCharacter) {
      const second = await h.helpers.character(user.id, 'Капитан');
      controlTurn = await h.chat(user.id, second.id, { message: scenario.controlOnSecondCharacter });
    } else {
      controlTurn = await h.chat(user.id, character.id, { message: scenario.control });
    }
    const answer = lastReply(controlTurn);
    const normalized = lower(answer);
    const expectAll = (scenario.expectAll ?? []).every((word) => normalized.includes(lower(word)));
    const expectAny = scenario.expectAny ? scenario.expectAny.some((word) => normalized.includes(lower(word))) : true;
    const forbidden = (scenario.forbidAsAnswer ?? []).filter((word) => normalized.includes(lower(word)));
    report.push({
      id: scenario.id, title: scenario.title, answer,
      autoPass: scenario.grading?.startsWith('manual:') ? null : expectAll && expectAny && forbidden.length === 0,
      forbiddenFound: forbidden,
      grading: scenario.grading ?? 'auto keywords',
      keyReplies: Object.keys(scenario.keyTurns ?? {}).map((n) => transcript[Number(n) - 1]),
      controlPromptTokens: controlTurn.promptTokens,
      costTelemetry: controlTurn.costMetrics,
    });
    console.log(`${scenario.id}: ${report.at(-1).autoPass === null ? 'manual review required' : report.at(-1).autoPass ? 'keyword checks passed (human review still needed)' : 'needs review'} — ${answer.slice(0, 160)}`);
  }
} finally {
  await h.stop();
}

if (out) writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`);
