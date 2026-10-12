import { performance } from 'node:perf_hooks';

// Direct fetch: same parser, no metering wrapper/consumer/idle timer/retry. Total deadline stays bounded.
export async function probeDirectStream({ body, key, runtime, totalMs = 120_000, emit = () => {}, fetcher = fetch }) {
  const started = performance.now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Diagnostic deadline'), { name: 'TimeoutError' })), totalMs);
  const elapsed = () => Math.round(performance.now() - started);
  let reader, readStarted = 0, lastChunkAt = null, firstTextMs = null;
  let bytesReceived = 0, chunkCount = 0, maxChunkGapMs = 0, lastReadWaitMs = 0;
  let status = null, headersMs = null, headerFields = {}, outcome = 'failed', failure = null;
  const usage = { inputTokens: null, outputTokens: null };
  const parser = new runtime.parser.ChatCompletionStreamParser(chunk => {
    if (runtime.parser.extractChatStreamDelta(chunk).trim()) firstTextMs ??= elapsed();
    if (Number.isSafeInteger(chunk.usage?.prompt_tokens) && chunk.usage.prompt_tokens >= 0) usage.inputTokens = chunk.usage.prompt_tokens;
    if (Number.isSafeInteger(chunk.usage?.completion_tokens) && chunk.usage.completion_tokens >= 0) usage.outputTokens = chunk.usage.completion_tokens;
  });
  try {
    const response = await fetcher('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    status = response.status; headersMs = elapsed();
    headerFields = runtime.diagnostics.safeTransportHeaders(response.headers, 'deepinfra');
    emit({ event: 'headers', elapsedMs: headersMs, status, ...headerFields });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      failure = { reason: response.ok ? 'missing_body' : 'http_error' };
    } else {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        readStarted = elapsed();
        const { done, value } = await reader.read();
        lastReadWaitMs = elapsed() - readStarted;
        if (done) break;
        const now = elapsed(), gap = lastChunkAt === null ? null : now - lastChunkAt;
        maxChunkGapMs = Math.max(maxChunkGapMs, gap ?? 0); lastChunkAt = now;
        bytesReceived += value.byteLength; chunkCount++;
        parser.push(decoder.decode(value, { stream: true }));
        if (chunkCount <= 20) emit({ event: 'chunk', elapsedMs: now, chunkIndex: chunkCount, chunkBytes: value.byteLength, chunkGapMs: gap });
      }
      parser.push(decoder.decode()); outcome = parser.end();
    }
  } catch (error) {
    lastReadWaitMs = reader ? elapsed() - readStarted : 0;
    let cause;
    try { cause = error?.cause; } catch { /* Ignore getters. */ }
    failure = { reason: controller.signal.aborted ? 'total_timeout' : 'transport_error',
      error: runtime.logger.toSafeDiagnostic(error), cause: runtime.logger.toSafeDiagnostic(cause) };
  } finally {
    clearTimeout(timer);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  parser.end();
  return { mode: 'direct', outcome, status, headersMs, firstTextMs, durationMs: elapsed(), bytesReceived,
    chunkCount, maxChunkGapMs, lastReadWaitMs, ...headerFields, ...parser.diagnostics(), ...usage, failure };
}

export async function probePipelineStream({ messages, modelName, key, runtime }) {
  const before = new Set(runtime.rows.keys()), started = performance.now();
  let outcome = 'failed', failure = null;
  await runtime.telemetry.withAiCostContext(async () => {
    try {
      const stream = await runtime.helpers.streamChatCompletion(modelName, messages, key);
      await runtime.consumer.consumeOpenAIChatCompletion(stream, () => {});
      outcome = 'completed';
    } catch (error) {
      failure = runtime.logger.toSafeDiagnostic(error);
    }
  });
  return { mode: 'pipeline', outcome, durationMs: Math.round(performance.now() - started), failure,
    attempts: [...runtime.rows.values()].filter(row => !before.has(row.id)).map(row => ({
      costEventId: row.id, operationId: row.operationId, outcome: row.outcome, status: row.httpStatus ?? null,
      durationMs: row.durationMs, providerRequestId: row.providerRequestId, providerResponseId: row.providerResponseId,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens,
    })) };
}
