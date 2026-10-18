import { createHash, randomUUID } from "node:crypto";
import type { MemoryJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { serviceChatPost } from "./aiTextClient";
import { getMemoryProvider } from "./aiProviders";
import { setAiCostActor, setAiCostThread, withAiCostContext } from "./aiCostTelemetry";
import { errorLog, infoLog, toSafeDiagnostic } from "./logger";
import { memoryScopeWhere, type ChatScope } from "./chatThreads";
import { countTokens } from "./tokenCount";
import { inferMemoryStatus, sameMemoryMeaning, STATUS_LABELS } from "./memoryNarrative";
import { FACT_EXTRACTION_RULES, MemoryExtractionError, coreToFacts, factCardinality, factExtractionFormat,
  factSources, memoryV2Enabled, parseFactExtraction, rankFacts, renderFactCore, sameFactValue, type FactDelta } from "./memoryFacts";

type Tx = Prisma.TransactionClient;
const LEASE_MS = 180_000;
const MAX_ATTEMPTS = 5;
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
  // Free the single-valued slot before inserting its successor (partial SQL index).
  const replaced = factCardinality(delta.key) === "single" ? active : [];
  if (replaced.length) await tx.memoryFact.updateMany({ where: { id: { in: replaced.map(fact => fact.id) } }, data: { status: "superseded" } });
  const previous = !record ? (await tx.memoryFact.findMany({ where: slot })).find(fact => sameFactValue(fact.value, delta.value, delta.key)) : null;
  const data = { ...slot, value: delta.value, cardinality: factCardinality(delta.key), status: "active", supersededById: null,
    source: delta.source, sourceMessageId: delta.sourceMessageId, seq, pinned: delta.pinned, confidence: delta.confidence };
  const next = previous ? await tx.memoryFact.update({ where: { id: previous.id }, data }) : await tx.memoryFact.create({ data });
  if (replaced.length) await tx.memoryFact.updateMany({ where: { id: { in: replaced.map(fact => fact.id) } }, data: { supersededById: next.id } });
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

async function processClaim(claim: NonNullable<Awaited<ReturnType<typeof claimJob>>>, apiKey: string) {
  const { job, owner, thread } = claim;
  const scope: ChatScope = { threadId: thread.id, characterId: thread.characterId, userId: thread.userId, legacy: false };
  try {
    const messages = await jobMessages(prisma, job), hash = fingerprint(messages), sources = factSources(messages);
    const activeFacts = await prisma.memoryFact.findMany({ where: { threadId: thread.id, status: "active" },
      select: { subject: true, key: true, value: true, pinned: true, source: true }, take: 150, orderBy: [{ pinned: "desc" }, { seq: "desc" }] });
    const input = JSON.stringify({ sources, activeFacts });
    if (input.length > 64_000 || countTokens(input) > 8000) throw new MemoryExtractionError("MEMORY_EXTRACT_INPUT_TOO_LARGE");
    let extraction: ReturnType<typeof parseFactExtraction> = { facts: [], events: [], rejectedRetractions: 0 };
    if (sources.length) {
      const response = await serviceChatPost("memory_extract", "https://api.kodikrouter.ru/v1/chat/completions", {
        model: "openai/gpt-4o-mini", messages: [{ role: "system", content: FACT_EXTRACTION_RULES }, { role: "user", content: input }],
        max_tokens: 2000, temperature: 0, response_format: getMemoryProvider() === "deepinfra"
          ? factExtractionFormat(sources.map(source => source.id)) : { type: "json_object" },
      }, { timeout: 20_000, headers: { Authorization: `Bearer ${apiKey}` } });
      if (response.data?.choices?.[0]?.finish_reason === "length") throw new MemoryExtractionError("MEMORY_EXTRACT_TRUNCATED");
      extraction = parseFactExtraction(response.data?.choices?.[0]?.message?.content ?? "", sources);
    }
    const applied = await prisma.$transaction(async tx => {
      await lockMemoryThread(tx, thread.id);
      const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
      if (!current || current.memoryLeaseOwner !== owner || current.memoryRevision !== job.revision) return false;
      const ids = messages.map(message => message.id);
      await tx.$queryRaw`SELECT id FROM "Message" WHERE id = ANY(${ids}::text[]) FOR SHARE`;
      if (fingerprint(await jobMessages(tx, job)) !== hash) throw new MemoryExtractionError("MEMORY_SOURCE_CHANGED");
      for (const delta of extraction.facts) await applyFact(tx, thread.id, delta, job.seq, "extractor", job.id, true, job.seq <= current.memoryManualSeq);
      const existing = await tx.episodicMemory.findMany({ where: { threadId: thread.id }, orderBy: { timestamp: "desc" }, take: 300 });
      for (const event of extraction.events) {
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
        errorCode: extraction.rejectedRetractions ? "MEMORY_EXTRACT_UNSUPPORTED_RETRACTION" : null } });
      await advanceWatermark(tx, thread.id);
      await tx.chatThread.update({ where: { id: thread.id }, data: { memoryLeaseOwner: null, memoryLeaseUntil: null } });
      return true;
    });
    if (applied) infoLog("MemoryV2", "turn processed", { seq: job.seq, attempts: job.attempts, facts: extraction.facts.length,
      events: extraction.events.length, rejectedRetractions: extraction.rejectedRetractions });
    return applied;
  } catch (error) {
    const code = error instanceof MemoryExtractionError ? error.code : "MEMORY_EXTRACT_PROVIDER_ERROR";
    await prisma.$transaction(async tx => {
      await lockMemoryThread(tx, thread.id);
      const current = await tx.chatThread.findUnique({ where: { id: thread.id } });
      if (current?.memoryLeaseOwner !== owner) return;
      await tx.memoryJob.update({ where: { id: job.id }, data: { status: job.attempts >= MAX_ATTEMPTS ? "failed" : "retry",
        errorCode: code, availableAt: new Date(Date.now() + Math.min(600_000, 15_000 * 2 ** (job.attempts - 1))) } });
      await tx.chatThread.update({ where: { id: thread.id }, data: { memoryLeaseOwner: null, memoryLeaseUntil: null } });
    });
    errorLog("MemoryV2", "turn deferred", { code, attempts: job.attempts, ...toSafeDiagnostic(error) });
    return false;
  }
}

export async function drainMemoryJobs(options: { threadId?: string; limit?: number; apiKey?: string } = {}) {
  if (!memoryV2Enabled()) return { processed: 0 };
  const limit = Math.min(10, Math.max(1, options.limit ?? 1));
  const threadIds = options.threadId ? [options.threadId] : (await prisma.memoryJob.findMany({
    where: { status: { in: ["queued", "retry", "processing", "awaiting_reply"] }, availableAt: { lte: new Date() } },
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
    await invalidateJob(tx, scope, job, deleted && job.userMessageId === messageId);
    if (deleted && job.userMessageId !== messageId) {
      const ids = job.assistantMessageIds.filter(id => id !== messageId);
      await tx.memoryJob.update({ where: { id: job.id }, data: { assistantMessageId: ids.at(-1) ?? null, assistantMessageIds: ids } });
    }
  }
  if (jobs.length) {
    await mirrorCore(tx, scope); await advanceWatermark(tx, scope.threadId);
  }
  // Older messages may predate durable jobs but still be part of a summary.
  // Keep the editor's copy and invalidate its use even when no job was found.
  await tx.memory.updateMany({ where: { threadId: scope.threadId }, data: { lastSummarizedAt: null, summarizedMessageCount: 0 } });
  await tx.chatThread.update({ where: { id: scope.threadId }, data: { memorySummaryInvalidated: true,
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
  const jobs = await prisma.memoryJob.groupBy({ by: ["status"], _count: { _all: true }, _min: { createdAt: true } });
  const guardedRetractions = await prisma.memoryJob.count({ where: { status: "succeeded", errorCode: "MEMORY_EXTRACT_UNSUPPORTED_RETRACTION" } });
  return { enabled: true, guardedRetractions, jobs: jobs.map(row => ({ status: row.status, count: row._count._all, oldestAt: row._min.createdAt })) };
}
