import { createHash, randomUUID } from "node:crypto";
import type { MemoryJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { serviceChatPost } from "./aiTextClient";
import { getMemoryProvider } from "./aiProviders";
import { setAiCostActor, setAiCostThread, withAiCostContext } from "./aiCostTelemetry";
import { errorLog, infoLog, toSafeDiagnostic } from "./logger";
import { memoryScopeWhere, type ChatScope } from "./chatThreads";
import { countTokens } from "./tokenCount";
import { inferMemoryStatus, isTrivialEvent, sameMemoryMeaning, STATUS_LABELS } from "./memoryNarrative";
import { FACT_EXTRACTION_RULES, MULTI_FACT_LIMIT, MemoryExtractionError, coreToFacts, factCardinality, factExtractionFormat, factValueCovers,
  factSources, memoryV2Enabled, parseFactExtraction, rankFacts, renderFactCore, sameFactValue, slotNoiseReason, npcAliasMap, isHeroName, fullNameInText, type FactDelta } from "./memoryFacts";

type Tx = Prisma.TransactionClient;
const LEASE_MS = 180_000;
const MAX_ATTEMPTS = 5;
// Backoff 15 s doubling to a 30 min cap: 14 attempts cover about 3.5 hours of provider trouble.
const MAX_TRANSIENT_ATTEMPTS = 14;
const MAX_INPUT_TOKENS = 8000, MAX_INPUT_CHARS = 64_000, FACT_CONTEXT_LIMIT = 150;
// Background work nobody waits for: Mistral writes ~400-600 JSON tokens at ~36-45 tok/s, so 40 s cut off
// about 2% of turns (prod 2026-10-18..20). The 180 s lease still bounds a stuck worker.
const EXTRACTION_TIMEOUT_MS = 75_000;
// A turn that cannot fit even without fact context fails identically on every retry.
const SKIPPED_OVERSIZED_TURN = "MEMORY_EXTRACT_SKIPPED_INPUT_TOO_LARGE";
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function lockMemoryThread(tx: Tx, threadId: string) {
  await tx.$queryRaw`SELECT id FROM "ChatThread" WHERE id = ${threadId} FOR UPDATE`;
}

async function applyFact(tx: Tx, threadId: string, delta: FactDelta, seq: number,
  actor: string, jobId: string | null, record = true, ignore = false) {
  const slot = { threadId, subject: delta.subject, key: delta.key };
  const active = await tx.memoryFact.findMany({ where: { ...slot, status: "active" } });
  const blocked = ignore || actor === "extractor" && active.some(fact => fact.source === "manual" && fact.pinned);
  if (record) await tx.memoryChange.create({ data: { ...slot, seq, jobId, actor,
    op: blocked ? "ignored" : delta.op, before: toJson(active.map(fact => ({ id: fact.id, value: fact.value, status: fact.status }))), after: toJson(delta) } });
  if (blocked) return;
  if (record && actor === "extractor" && await tx.memoryChange.findFirst({ where: { ...slot, invalidated: false,
    seq: { gt: seq }, op: { in: ["set", "retract"] } } })) {
    await replaySlot(tx, threadId, delta.subject, delta.key);
    return;
  }
  if (delta.op === "retract") {
    const ids = active.filter(fact => !delta.value || sameFactValue(fact.value, delta.value, delta.key)).map(fact => fact.id);
    if (ids.length) await tx.memoryFact.updateMany({ where: { id: { in: ids } }, data: { status: "retracted", supersededById: null } });
    return;
  }
  const repeated = active.find(fact => sameFactValue(fact.value, delta.value, delta.key));
  if (repeated) {
    await tx.memoryFact.update({ where: { id: repeated.id }, data: {
      seq, source: delta.source, sourceMessageId: delta.sourceMessageId, pinned: delta.pinned, confidence: delta.confidence,
    } });
    return;
  }
  const multi = factCardinality(delta.key) === "multi";
  // A value already contained in a fuller one adds nothing; a fuller value replaces the narrower
  // unpinned ones it contains. Without this a slot only grew («танцы», «танцы и косплеи», …).
  if (multi && active.some(fact => factValueCovers(fact.value, delta.value, delta.key))) return;
  // Free the single-valued slot before inserting its successor (partial SQL index).
  const replaced = multi ? active.filter(fact => !fact.pinned && factValueCovers(delta.value, fact.value, delta.key)) : active;
  if (replaced.length) await tx.memoryFact.updateMany({ where: { id: { in: replaced.map(fact => fact.id) } }, data: { status: "superseded" } });
  const previous = !record ? (await tx.memoryFact.findMany({ where: slot })).find(fact => sameFactValue(fact.value, delta.value, delta.key)) : null;
  const data = { ...slot, value: delta.value, cardinality: factCardinality(delta.key), status: "active", supersededById: null,
    source: delta.source, sourceMessageId: delta.sourceMessageId, seq, pinned: delta.pinned, confidence: delta.confidence };
  const next = previous ? await tx.memoryFact.update({ where: { id: previous.id }, data }) : await tx.memoryFact.create({ data });
  if (replaced.length) await tx.memoryFact.updateMany({ where: { id: { in: replaced.map(fact => fact.id) } }, data: { supersededById: next.id } });
  if (!multi) return;
  // A capped slot: noise stored before the slot checks goes first, then the oldest unpinned values;
  // manual pinned facts are never evicted.
  const kept = (await tx.memoryFact.findMany({ where: { ...slot, status: "active" }, orderBy: [{ seq: "desc" }, { id: "desc" }] }))
    .sort((a, b) => Number(!a.pinned && !!slotNoiseReason(a.key, a.value)) - Number(!b.pinned && !!slotNoiseReason(b.key, b.value)));
  const evicted = kept.filter(fact => !fact.pinned && fact.id !== next.id).slice(Math.max(0, MULTI_FACT_LIMIT - kept.filter(fact => fact.pinned).length - (next.pinned ? 0 : 1)));
  if (evicted.length) await tx.memoryFact.updateMany({ where: { id: { in: evicted.map(fact => fact.id) } }, data: { status: "superseded", supersededById: next.id } });
}

async function initializeFacts(tx: Tx, scope: ChatScope) {
  const thread = await tx.chatThread.findUniqueOrThrow({ where: { id: scope.threadId } });
  if (thread.userId !== scope.userId || thread.characterId !== scope.characterId) throw new Error("MEMORY_SCOPE_MISMATCH");
  if (thread.memoryV2Initialized) return;
  const old = await tx.coreMemory.findUnique({ where: { threadId: scope.threadId } });
  for (const fact of coreToFacts(old?.content ?? "")) await applyFact(tx, scope.threadId, fact, 0, "bootstrap", null);
  await tx.chatThread.update({ where: { id: scope.threadId }, data: { memoryV2Initialized: true } });
}

async function mirrorCore(tx: Tx, scope: ChatScope) {
  const facts = await tx.memoryFact.findMany({ where: { threadId: scope.threadId, status: "active" }, orderBy: [{ pinned: "desc" }, { seq: "desc" }, { id: "asc" }] });
  // Keep whole facts. The database retains facts outside the compatibility text allowance.
  const kept: typeof facts = [];
  for (const fact of rankFacts(facts)) {
    if (renderFactCore([...kept, fact]).length <= 6000) kept.push(fact);
    else if (fact.pinned) throw new MemoryExtractionError("MEMORY_PINNED_FACTS_TOO_LARGE");
  }
  const content = renderFactCore(kept), key = memoryScopeWhere(scope);
  const core = await tx.coreMemory.upsert({ where: { threadId: scope.threadId }, create: { ...key, content }, update: { content } });
  await tx.memoryEntry.deleteMany({ where: { ...key, type: "core" } });
  if (content) await tx.memoryEntry.create({ data: { ...key, type: "core", content } });
  return core;
}

export async function readFactCore(scope: ChatScope, query = ""): Promise<string | null> {
  if (!memoryV2Enabled()) return null;
  const thread = await prisma.chatThread.findUnique({ where: { id: scope.threadId }, select: { memoryV2Initialized: true } });
  if (!thread?.memoryV2Initialized) return null;
  const where = { threadId: scope.threadId, status: "active" };
  const terms = [...new Set(query.match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 6);
  const rows = await Promise.all([
    prisma.memoryFact.findMany({ where, orderBy: [{ seq: "desc" }, { id: "asc" }], take: 150 }),
    prisma.memoryFact.findMany({ where: { ...where, OR: [{ pinned: true }, { cardinality: "single" }] },
      orderBy: [{ pinned: "desc" }, { seq: "desc" }], take: 200 }),
    terms.length ? prisma.memoryFact.findMany({ where: { ...where, OR: terms.map(term => ({ value: { contains: term, mode: "insensitive" as const } })) },
      orderBy: { seq: "desc" }, take: 80 }) : Promise.resolve([]),
  ]);
  const facts = [...new Map(rows.flat().map(fact => [fact.id, fact])).values()];
  const kept: typeof facts = [];
  for (const fact of rankFacts(facts, query)) if (renderFactCore([...kept, fact]).length <= 6000) kept.push(fact);
  return renderFactCore(kept);
}

/** Called in the SAME transaction that saves the user message. No paid work here. */
export async function enqueueMemoryTurn(tx: Tx, scope: ChatScope, userMessageId: string) {
  await lockMemoryThread(tx, scope.threadId);
  const existing = await tx.memoryJob.findUnique({ where: { userMessageId } });
  if (existing) return existing;
  const message = await tx.message.findFirst({ where: { id: userMessageId, ...memoryScopeWhere(scope), role: "user" } });
  if (!message) throw new Error("MEMORY_SOURCE_MISSING");
  const thread = await tx.chatThread.update({ where: { id: scope.threadId }, data: { memoryNextSeq: { increment: 1 } } });
  return tx.memoryJob.create({ data: { threadId: scope.threadId, userMessageId, seq: thread.memoryNextSeq } });
}

/** Completion is also committed with the assistant message, so a crash is recoverable. */
export async function finishMemoryTurn(tx: Tx, userMessageId: string, assistantMessageId: string | null) {
  await tx.memoryJob.updateMany({ where: { userMessageId, status: "awaiting_reply" }, data: {
    assistantMessageId, assistantMessageIds: assistantMessageId ? [assistantMessageId] : [], status: "queued", availableAt: new Date(),
  } });
}

export async function attachMemoryReply(tx: Tx, scope: ChatScope, userMessageId: string, assistantMessageId: string, append = false) {
  await lockMemoryThread(tx, scope.threadId);
  const job = await enqueueMemoryTurn(tx, scope, userMessageId);
  if (job.status !== "awaiting_reply") await invalidateMessageMemory(tx, scope, userMessageId);
  await tx.memoryJob.update({ where: { id: job.id }, data: { assistantMessageId,
    assistantMessageIds: [...new Set([...(append ? job.assistantMessageIds : []), assistantMessageId])], status: "queued", availableAt: new Date() } });
}

const fingerprint = (messages: Array<{ id: string; role: string; content: string }>) => createHash("sha256")
  .update(JSON.stringify(messages.map(message => [message.id, message.role, message.content]))).digest("hex");
async function jobMessages(tx: Tx | typeof prisma, job: MemoryJob) {
  const assistantIds = job.assistantMessageIds.length ? job.assistantMessageIds : job.assistantMessageId ? [job.assistantMessageId] : [];
  const ids = [job.userMessageId, ...assistantIds].filter((id): id is string => Boolean(id));
  const rows = await tx.message.findMany({ where: { id: { in: ids }, threadId: job.threadId } });
  const user = rows.find(row => row.id === job.userMessageId && row.role === "user");
  const assistants = assistantIds.map(id => rows.find(row => row.id === id && row.role === "assistant"));
  if (!user || assistants.some(row => !row)) throw new MemoryExtractionError("MEMORY_SOURCE_MISSING");
  return [user, ...assistants.filter((row): row is NonNullable<typeof row> => Boolean(row))];
}

async function advanceWatermark(tx: Tx, threadId: string) {
  const firstPending = await tx.memoryJob.findFirst({ where: { threadId, status: { notIn: ["succeeded", "cancelled"] } }, orderBy: { seq: "asc" }, select: { seq: true } });
  const prefix = { threadId, ...(firstPending ? { seq: { lt: firstPending.seq } } : {}) };
  const last = await tx.memoryJob.findFirst({ where: prefix, orderBy: { seq: "desc" }, select: { seq: true } });
  const processed = await tx.memoryJob.findFirst({ where: { ...prefix, status: "succeeded" }, orderBy: { seq: "desc" },
    select: { userMessageId: true, assistantMessageId: true } });
  await tx.chatThread.update({ where: { id: threadId }, data: {
    memoryWatermarkSeq: last?.seq ?? 0, memoryWatermarkMessageId: processed?.assistantMessageId ?? processed?.userMessageId ?? null,
  } });
}

async function claimJob(threadId: string) {
  const owner = randomUUID();
  return prisma.$transaction(async tx => {
    await lockMemoryThread(tx, threadId);
    const thread = await tx.chatThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.memoryLeaseUntil && thread.memoryLeaseUntil > new Date()) return null;
    let job = await tx.memoryJob.findFirst({ where: { threadId, status: { notIn: ["succeeded", "cancelled"] } }, orderBy: { seq: "asc" } });
    if (!job || job.status === "failed" || job.availableAt > new Date()) return null;
    if (job.status === "awaiting_reply") {
      if (job.createdAt.getTime() + LEASE_MS > Date.now()) return null;
      // Atomic completion normally supplies the reply. A process that died during
      // generation still leaves a user-only turn instead of silently dropping it.
      await tx.memoryJob.update({ where: { id: job.id }, data: { status: "queued" } });
    }
    await initializeFacts(tx, { userId: thread.userId, characterId: thread.characterId, threadId, legacy: false });
    job = await tx.memoryJob.update({ where: { id: job.id }, data: { status: "processing", attempts: { increment: 1 },
      startedAt: new Date(), errorCode: null, revision: thread.memoryRevision } });
    await tx.chatThread.update({ where: { id: threadId }, data: { memoryLeaseOwner: owner, memoryLeaseUntil: new Date(Date.now() + LEASE_MS) } });
    return { job, owner, thread };
  });
}

/** Facts are context for the extractor, not its source: pinned and recent ones are kept while they fit.
 * A fixed count made every story that reached ~150 facts exceed the token limit and block its queue. */
export function fitExtractionInput<T>(sources: unknown[], facts: T[]) {
  const render = (count: number) => JSON.stringify({ sources, activeFacts: facts.slice(0, count) });
  const measure = (text: string) => text.length > MAX_INPUT_CHARS ? Infinity : countTokens(text);
  if (measure(render(0)) > MAX_INPUT_TOKENS) return null;
  let low = 0, high = facts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(render(middle)) <= MAX_INPUT_TOKENS) low = middle; else high = middle - 1;
  }
  const input = render(low);
  return { input, tokens: measure(input), factsIncluded: low };
}

async function processClaim(claim: NonNullable<Awaited<ReturnType<typeof claimJob>>>, apiKey: string) {
  const { job, owner, thread } = claim;
  const scope: ChatScope = { threadId: thread.id, characterId: thread.characterId, userId: thread.userId, legacy: false };
  const startedAt = Date.now(), timeoutMs = EXTRACTION_TIMEOUT_MS;
  const diagnostic: { sourceCount?: number; inputChars?: number; inputTokens?: number; responseChars?: number; finishReason?: string;
    factsIncluded?: number; factsOmitted?: number } = {};
  let stage = "load_sources";
  try {
    const messages = await jobMessages(prisma, job), hash = fingerprint(messages), sources = factSources(messages);
    stage = "prepare_input"; diagnostic.sourceCount = sources.length;
    // The hero's names. A short stored name («Ортега») is completed once from the user's own introduction
    // («Навигатор Кай Ортега прибыл»), so the crew's «Кай» is recognised as the hero.
    const hero = await prisma.memoryFact.findFirst({ where: { threadId: thread.id, subject: "user", key: "name", status: "active" }, orderBy: { seq: "desc" } });
    const introduced = hero && !hero.pinned ? await prisma.message.findFirst({ where: { threadId: thread.id, role: "user", content: { contains: hero.value } },
      orderBy: { createdAt: "asc" }, select: { id: true, content: true } }) : null;
    const fullName = hero && introduced ? fullNameInText(hero.value, introduced.content) : null;
    const completedName = introduced && fullName && fullName !== hero?.value ? { value: fullName, messageId: introduced.id } : null;
    const heroNames = [hero?.value, completedName?.value].filter((name): name is string => Boolean(name));
    const activeFacts = await prisma.memoryFact.findMany({ where: { threadId: thread.id, status: "active" },
      select: { subject: true, key: true, value: true, pinned: true, source: true }, take: FACT_CONTEXT_LIMIT, orderBy: [{ pinned: "desc" }, { seq: "desc" }] })
      // Stored noise would teach the extractor to file more of it; two names of one NPC, to keep two cards;
      // an NPC card of the hero, to keep filing the user's facts there.
      .then(rows => {
        const alias = npcAliasMap(rows.map(fact => fact.subject));
        return rows.filter(fact => fact.pinned || !slotNoiseReason(fact.key, fact.value) && !isHeroName(fact.subject, heroNames))
          .map(fact => ({ ...fact, subject: alias.get(fact.subject) ?? fact.subject }));
      });
    const fitted = fitExtractionInput(sources, activeFacts);
    if (!fitted) throw new MemoryExtractionError("MEMORY_EXTRACT_INPUT_TOO_LARGE");
    const input = fitted.input;
    diagnostic.inputChars = input.length; diagnostic.inputTokens = fitted.tokens;
    diagnostic.factsIncluded = fitted.factsIncluded; diagnostic.factsOmitted = activeFacts.length - fitted.factsIncluded;
    let extraction: ReturnType<typeof parseFactExtraction> = { facts: [], events: [], rejectedRetractions: 0,
      rejectedFacts: 0, rejectedEvents: 0, rejectedCandidates: [] };
    if (sources.length) {
      stage = "provider_request";
      const response = await serviceChatPost("memory_extract", "https://api.kodikrouter.ru/v1/chat/completions", {
        model: "openai/gpt-4o-mini", messages: [{ role: "system", content: FACT_EXTRACTION_RULES }, { role: "user", content: input }],
        max_tokens: 2000, temperature: 0, response_format: getMemoryProvider() === "deepinfra"
          ? factExtractionFormat(sources.map(source => source.id)) : { type: "json_object" },
      }, { timeout: timeoutMs, headers: { Authorization: `Bearer ${apiKey}` } });
      stage = "validate_response";
      const content = response.data?.choices?.[0]?.message?.content ?? "";
      diagnostic.responseChars = typeof content === "string" ? content.length : 0;
      const finishReason = response.data?.choices?.[0]?.finish_reason;
      diagnostic.finishReason = ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(finishReason) ? finishReason : "unknown";
      if (response.data?.choices?.[0]?.finish_reason === "length") throw new MemoryExtractionError("MEMORY_EXTRACT_TRUNCATED");
      extraction = parseFactExtraction(content, sources, { partial: true, heroNames });
    }
    const hasRejectedCandidates = extraction.rejectedFacts + extraction.rejectedEvents > 0;
    const warningCode = hasRejectedCandidates ? extraction.facts.length + extraction.events.length > 0
      ? "MEMORY_EXTRACT_PARTIAL" : "MEMORY_EXTRACT_REJECTED_ALL"
      : extraction.rejectedRetractions ? "MEMORY_EXTRACT_UNSUPPORTED_RETRACTION" : null;
    stage = "commit";
    const applied = await prisma.$transaction(async tx => {
      await lockMemoryThread(tx, thread.id);
      const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
      if (!current || current.memoryLeaseOwner !== owner || current.memoryRevision !== job.revision) return false;
      const ids = messages.map(message => message.id);
      await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ANY(${ids}::text[]) FOR SHARE`;
      if (fingerprint(await jobMessages(tx, job)) !== hash) throw new MemoryExtractionError("MEMORY_SOURCE_CHANGED");
      if (completedName) await applyFact(tx, thread.id, { op: "set", subject: "user", key: "name", value: completedName.value, source: "user_msg",
        sourceMessageId: completedName.messageId, confidence: 1, pinned: false }, job.seq, "extractor", job.id, true, job.seq <= current.memoryManualSeq);
      // A fact about «Ирма» goes to the card already stored as «Ирма Сол» (and the reverse is joined when rendered).
      const npcs = (await tx.memoryFact.findMany({ where: { threadId: thread.id, status: "active", subject: { startsWith: "npc:" } },
        select: { subject: true }, distinct: ["subject"] })).map(fact => fact.subject);
      for (const extracted of extraction.facts) {
        const subject = npcAliasMap([...npcs, extracted.subject]).get(extracted.subject) ?? extracted.subject;
        if (subject.startsWith("npc:") && !npcs.includes(subject)) npcs.push(subject);
        const delta = { ...extracted, subject };
        await applyFact(tx, thread.id, delta, job.seq, "extractor", job.id, true, job.seq <= current.memoryManualSeq);
      }
      const existing = await tx.episodicMemory.findMany({ where: { threadId: thread.id }, orderBy: { timestamp: "desc" }, take: 300 });
      for (const event of extraction.events) {
        // A two-word quote («Можешь.», «За спину.») is a gesture, not an event: 49 of 104 events of
        // one 196-message story were such fragments, filling the prompt with noise (prod 2026-10-24).
        if (isTrivialEvent(event.text)) continue;
        const status = inferMemoryStatus(event.text);
        const text = `${event.source === "character" ? "По словам персонажа: " : ""}[${STATUS_LABELS[status]}] ${event.text}`;
        if (existing.some(row => sameMemoryMeaning(row.event, text))) continue;
        const projection = await tx.episodicMemory.create({ data: { ...memoryScopeWhere(scope), event: text,
          importance: event.importance, timestamp: messages[0].createdAt, sourceMemoryJobId: job.id } });
        existing.push(projection);
        await tx.memoryEntry.create({ data: { ...memoryScopeWhere(scope), type: "episodic", content: text } });
      }
      // Retain the existing episode cap while the StoryEvent lifecycle is deferred.
      const overflow = await tx.episodicMemory.findMany({ where: { threadId: thread.id }, orderBy: [{ importance: "desc" }, { timestamp: "desc" }], skip: 300, select: { id: true } });
      if (overflow.length) await tx.episodicMemory.deleteMany({ where: { id: { in: overflow.map(row => row.id) } } });
      await mirrorCore(tx, scope);
      await tx.memoryJob.update({ where: { id: job.id }, data: { status: "succeeded", sourceFingerprint: hash, finishedAt: new Date(),
        errorCode: warningCode } });
      await advanceWatermark(tx, thread.id);
      await tx.chatThread.update({ where: { id: thread.id }, data: { memoryLeaseOwner: null, memoryLeaseUntil: null } });
      return true;
    });
    if (applied) infoLog("MemoryV2", "turn processed", { jobId: job.id, seq: job.seq, attempt: job.attempts, willRetry: false,
      durationMs: Date.now() - startedAt, inputTokens: diagnostic.inputTokens, factsIncluded: diagnostic.factsIncluded,
      factsOmitted: diagnostic.factsOmitted, facts: extraction.facts.length,
      events: extraction.events.length, rejectedRetractions: extraction.rejectedRetractions,
      rejectedFacts: extraction.rejectedFacts, rejectedEvents: extraction.rejectedEvents, warningCode,
      ...(hasRejectedCandidates ? { rejectedCandidates: extraction.rejectedCandidates } : {}) });
    return applied;
  } catch (error) {
    const safe = toSafeDiagnostic(error), validation = error instanceof MemoryExtractionError ? error.diagnostic : {};
    const providerCode = typeof safe.code === "string" ? safe.code : undefined;
    const timedOut = stage === "provider_request" && ["ECONNABORTED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(providerCode ?? "");
    const code = error instanceof MemoryExtractionError ? error.code : stage === "provider_request"
      ? timedOut ? "MEMORY_EXTRACT_PROVIDER_TIMEOUT" : "MEMORY_EXTRACT_PROVIDER_ERROR"
      : safe.category === "prisma" ? "MEMORY_EXTRACT_PERSISTENCE_ERROR" : "MEMORY_EXTRACT_PROCESSING_ERROR";
    const storedCode = validation.validationReason ? `${code}:${validation.validationReason}` : code;
    if (code === "MEMORY_SOURCE_MISSING") {
      // Without its user message the turn can never be extracted; retrying only blocks the story.
      // Withdraw whatever it contributed and cancel it. A missing reply alone keeps the normal retry.
      const cancelled = await prisma.$transaction(async tx => {
        await lockMemoryThread(tx, thread.id);
        const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
        if (current?.memoryLeaseOwner !== owner) return null;
        const fresh = await tx.memoryJob.findUnique({ where: { id: job.id } });
        const userPresent = fresh?.userMessageId ? await tx.message.findFirst({
          where: { id: fresh.userMessageId, threadId: thread.id, role: "user" }, select: { id: true } }) : null;
        if (!fresh || userPresent) return false;
        await invalidateJob(tx, scope, fresh, true);
        await tx.memoryJob.update({ where: { id: job.id }, data: { attempts: job.attempts, errorCode: "MEMORY_SOURCE_MISSING", finishedAt: new Date() } });
        await mirrorCore(tx, scope); await advanceWatermark(tx, thread.id);
        return true;
      });
      if (cancelled) {
        infoLog("MemoryV2", "turn cancelled", { code, stage, jobId: job.id, seq: job.seq, attempt: job.attempts, willRetry: false,
          durationMs: Date.now() - startedAt });
        return true;
      }
      if (cancelled === null) {
        infoLog("MemoryV2", "turn failure ignored", { code, stage, jobId: job.id, seq: job.seq, outcome: "lease_lost" });
        return false;
      }
    }
    if (code === "MEMORY_EXTRACT_INPUT_TOO_LARGE") {
      // Retrying cannot shrink this turn, and a failed head would stop the story's memory for good.
      // Skip it explicitly; earlier facts stay intact and later turns continue in order.
      const skipped = await prisma.$transaction(async tx => {
        await lockMemoryThread(tx, thread.id);
        const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
        if (current?.memoryLeaseOwner !== owner) return false;
        await tx.memoryJob.update({ where: { id: job.id }, data: { status: "succeeded", errorCode: SKIPPED_OVERSIZED_TURN, finishedAt: new Date() } });
        await advanceWatermark(tx, thread.id);
        await tx.chatThread.update({ where: { id: thread.id }, data: { memoryLeaseOwner: null, memoryLeaseUntil: null } });
        return true;
      });
      const context = { ...diagnostic, code: SKIPPED_OVERSIZED_TURN, stage, jobId: job.id, seq: job.seq, attempt: job.attempts,
        durationMs: Date.now() - startedAt };
      if (skipped) errorLog("MemoryV2", "turn skipped", { ...context, willRetry: false });
      else infoLog("MemoryV2", "turn failure ignored", { ...context, outcome: "lease_lost" });
      return skipped;
    }
    // A provider outage (timeout, 5xx, 429, lost connection) is not the turn's fault. Five attempts spanned
    // ~4 minutes, so an hour of DeepInfra trouble left a failed head that blocked the story for good
    // (prod 2026-10-21 15:04 and 16:29). Such failures keep retrying for hours; bad output still stops at five.
    const providerStatus = typeof safe.status === "number" ? safe.status : undefined;
    const transient = stage === "provider_request" && !(error instanceof MemoryExtractionError)
      && (providerStatus === undefined || providerStatus >= 500 || providerStatus === 429);
    const maxAttempts = transient ? MAX_TRANSIENT_ATTEMPTS : MAX_ATTEMPTS;
    const retryDelayMs = Math.min(transient ? 1_800_000 : 600_000, 15_000 * 2 ** (job.attempts - 1));
    const willRetry = job.attempts < maxAttempts, availableAt = new Date(Date.now() + retryDelayMs);
    const deferred = await prisma.$transaction(async tx => {
      await lockMemoryThread(tx, thread.id);
      const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
      if (current?.memoryLeaseOwner !== owner) return false;
      await tx.memoryJob.update({ where: { id: job.id }, data: { status: willRetry ? "retry" : "failed",
        errorCode: storedCode, availableAt, finishedAt: willRetry ? null : new Date() } });
      await tx.chatThread.update({ where: { id: thread.id }, data: { memoryLeaseOwner: null, memoryLeaseUntil: null } });
      return true;
    });
    const context = { ...safe, ...diagnostic, ...validation, code, ...(providerCode ? { providerCode } : {}), stage,
      jobId: job.id, seq: job.seq, attempt: job.attempts, maxAttempts, timeoutMs, durationMs: Date.now() - startedAt };
    if (!deferred) infoLog("MemoryV2", "turn failure ignored", { ...context, outcome: "lease_lost" });
    else errorLog("MemoryV2", willRetry ? "turn deferred" : "turn failed", { ...context, willRetry,
      ...(willRetry ? { retryDelayMs, nextAttemptAt: availableAt.toISOString() } : {}) });
    return false;
  }
}

export async function drainMemoryJobs(options: { threadId?: string; limit?: number; apiKey?: string } = {}) {
  if (!memoryV2Enabled()) return { processed: 0 };
  const limit = Math.min(10, Math.max(1, options.limit ?? 1));
  // A story whose head job failed cannot advance until an operator retries it. Such stories hold the
  // oldest queued jobs, so without this filter enough of them would fill every slot and starve all others.
  const threadIds = options.threadId ? [options.threadId] : (await prisma.memoryJob.findMany({
    where: { status: { in: ["queued", "retry", "processing", "awaiting_reply"] }, availableAt: { lte: new Date() },
      thread: { memoryJobs: { none: { status: "failed" } } } },
    distinct: ["threadId"], orderBy: { availableAt: "asc" }, take: 30, select: { threadId: true },
  })).map(row => row.threadId);
  let processed = 0, attempted = 0;
  for (const threadId of threadIds) {
    for (let count = 0; count < limit && attempted < limit; count++) {
      const claim = await claimJob(threadId);
      if (!claim) break;
      attempted++;
      const success = await withAiCostContext(async () => {
        const user = await prisma.user.findUnique({ where: { id: claim.thread.userId }, select: { subscriptionType: true } });
        setAiCostActor(claim.thread.userId, user?.subscriptionType); setAiCostThread(threadId);
        return processClaim(claim, options.apiKey ?? process.env.KODIKROUTER_API_KEY ?? "");
      });
      if (!success) break;
      processed++;
    }
    if (attempted >= limit) break;
  }
  return { processed };
}

/** Re-materialise only affected slots from surviving assertions after source edits. */
async function replaySlot(tx: Tx, threadId: string, subject: string, key: string) {
  await tx.memoryFact.updateMany({ where: { threadId, subject, key }, data: { status: "retracted", supersededById: null } });
  const history = await tx.memoryChange.findMany({ where: { threadId, subject, key, invalidated: false, op: { in: ["set", "retract"] } },
    orderBy: [{ seq: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  for (const change of history) await applyFact(tx, threadId, change.after as unknown as FactDelta, change.seq, change.actor, change.jobId, false);
}

async function invalidateJob(tx: Tx, scope: ChatScope, job: MemoryJob, deleted = false) {
  const affected = await tx.memoryChange.findMany({ where: { jobId: job.id, invalidated: false }, select: { subject: true, key: true } });
  await tx.memoryChange.updateMany({ where: { jobId: job.id }, data: { invalidated: true } });
  const projections = await tx.episodicMemory.findMany({ where: { sourceMemoryJobId: job.id }, select: { event: true } });
  await tx.episodicMemory.deleteMany({ where: { sourceMemoryJobId: job.id } });
  if (projections.length) await tx.memoryEntry.deleteMany({ where: { ...memoryScopeWhere(scope), type: "episodic", content: { in: projections.map(row => row.event) } } });
  for (const { subject, key } of [...new Map(affected.map(slot => [`${slot.subject}:${slot.key}`, slot])).values()]) {
    await replaySlot(tx, scope.threadId, subject, key);
  }
  await tx.memoryJob.update({ where: { id: job.id }, data: { status: deleted ? "cancelled" : "queued", attempts: 0,
    availableAt: new Date(), sourceFingerprint: null, finishedAt: null, errorCode: null } });
  await tx.chatThread.update({ where: { id: scope.threadId }, data: { memoryRevision: { increment: 1 }, memoryLeaseOwner: null, memoryLeaseUntil: null } });
}

export async function invalidateMessageMemory(tx: Tx, scope: ChatScope, messageId: string, deleted = false) {
  await lockMemoryThread(tx, scope.threadId);
  const jobs = await tx.memoryJob.findMany({ where: { threadId: scope.threadId,
    OR: [{ userMessageId: messageId }, { assistantMessageId: messageId }, { assistantMessageIds: { has: messageId } }] } });
  for (const job of jobs) {
    // A cancelled turn already had its claims withdrawn. Deleting its reply afterwards found it by the
    // assistant id and requeued it without a user message: five MEMORY_SOURCE_MISSING failures, then a
    // failed head that blocked the story (prod 2026-10-20). A turn whose user message is gone stays cancelled.
    if (job.status === "cancelled") continue;
    await invalidateJob(tx, scope, job, deleted && job.userMessageId === messageId || job.userMessageId === null);
    if (deleted && job.userMessageId !== messageId) {
      const ids = job.assistantMessageIds.filter(id => id !== messageId);
      await tx.memoryJob.update({ where: { id: job.id }, data: { assistantMessageId: ids.at(-1) ?? null, assistantMessageIds: ids } });
    }
  }
  if (jobs.length) {
    await mirrorCore(tx, scope); await advanceWatermark(tx, scope.threadId);
  }
  // Older messages may predate durable jobs but still be part of a summary. Keep the editor's copy
  // and invalidate its use when the summary covers the changed message, or when its coverage is
  // unknown (a manual or legacy summary may describe anything). Resetting it for the newest reply
  // (regenerate, continue) restarted the summary from the first message and dropped all memory
  // from the prompt for the rest of the session (prod 2026-10-24).
  const message = await tx.message.findUnique({ where: { id: messageId }, select: { createdAt: true } });
  const summary = await tx.memory.findUnique({ where: { threadId: scope.threadId }, select: { summary: true, lastSummarizedAt: true } });
  const covered = Boolean(summary?.summary.trim()) && (!summary?.lastSummarizedAt || !message
    || message.createdAt.getTime() <= summary.lastSummarizedAt.getTime());
  if (covered) await tx.memory.updateMany({ where: { threadId: scope.threadId }, data: { lastSummarizedAt: null, summarizedMessageCount: 0 } });
  await tx.chatThread.update({ where: { id: scope.threadId }, data: { ...(covered ? { memorySummaryInvalidated: true } : {}),
    memoryRevision: { increment: 1 }, memoryLeaseOwner: null, memoryLeaseUntil: null } });
}

export async function replaceManualFactCore(scope: ChatScope, content: string) {
  return prisma.$transaction(async tx => {
    await lockMemoryThread(tx, scope.threadId); await initializeFacts(tx, scope);
    const thread = await tx.chatThread.update({ where: { id: scope.threadId }, data: {
      memoryNextSeq: { increment: 1 }, memoryRevision: { increment: 1 }, memoryLeaseOwner: null, memoryLeaseUntil: null,
    } });
    await tx.chatThread.update({ where: { id: scope.threadId }, data: { memoryManualSeq: thread.memoryNextSeq } });
    const active = await tx.memoryFact.findMany({ where: { threadId: scope.threadId, status: "active" } });
    for (const fact of active) await applyFact(tx, scope.threadId, { op: "retract", subject: fact.subject, key: fact.key,
      value: fact.value, source: "manual", sourceMessageId: null, pinned: true, confidence: 1 }, thread.memoryNextSeq, "manual", null);
    for (const fact of coreToFacts(content, true)) await applyFact(tx, scope.threadId, fact, thread.memoryNextSeq, "manual", null);
    return mirrorCore(tx, scope);
  });
}

export async function clearFactMemory(scope: ChatScope) {
  return prisma.$transaction(async tx => {
    await lockMemoryThread(tx, scope.threadId);
    await tx.memoryChange.deleteMany({ where: { threadId: scope.threadId } });
    await tx.memoryFact.deleteMany({ where: { threadId: scope.threadId } });
    await tx.memoryJob.deleteMany({ where: { threadId: scope.threadId } });
    const key = memoryScopeWhere(scope);
    await tx.memory.deleteMany({ where: key }); await tx.coreMemory.deleteMany({ where: key });
    await tx.episodicMemory.deleteMany({ where: key }); await tx.memoryEntry.deleteMany({ where: key });
    await tx.chatThread.update({ where: { id: scope.threadId }, data: { memoryRevision: { increment: 1 },
      memoryWatermarkSeq: 0, memoryWatermarkMessageId: null, memoryV2Initialized: false, memoryLeaseOwner: null, memoryLeaseUntil: null,
      memorySummaryInvalidated: false } });
  });
}

export async function memoryJobStatus() {
  if (!memoryV2Enabled()) return { enabled: false, jobs: [] };
  const [jobs, warnings] = await Promise.all([
    prisma.memoryJob.groupBy({ by: ["status"], _count: { _all: true }, _min: { createdAt: true } }),
    prisma.memoryJob.groupBy({ by: ["errorCode"], where: { status: "succeeded", errorCode: { in: [
      "MEMORY_EXTRACT_UNSUPPORTED_RETRACTION", "MEMORY_EXTRACT_PARTIAL", "MEMORY_EXTRACT_REJECTED_ALL", SKIPPED_OVERSIZED_TURN,
    ] } }, _count: { _all: true } }),
  ]);
  const count = (code: string) => warnings.find(row => row.errorCode === code)?._count._all ?? 0;
  return { enabled: true, guardedRetractions: count("MEMORY_EXTRACT_UNSUPPORTED_RETRACTION"),
    partialExtractions: count("MEMORY_EXTRACT_PARTIAL"), rejectedAllExtractions: count("MEMORY_EXTRACT_REJECTED_ALL"),
    skippedOversizedTurns: count(SKIPPED_OVERSIZED_TURN),
    jobs: jobs.map(row => ({ status: row.status, count: row._count._all, oldestAt: row._min.createdAt })) };
}
