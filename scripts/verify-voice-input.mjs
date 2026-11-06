// Run with node --test scripts/verify-voice-input.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { createModuleLoader } from "./lib/memory-test-harness.mjs";

test("voice input validates and bounds audio before sending it to the transcription service", async t => {
  const session = { userId: "synthetic-user" };
  let hits = 0;
  let count = 1;
  let upstream = { text: "  This is a test.  " };
  const { load, root } = createModuleLoader({
    session,
    prismaFor: () => ({ $queryRaw: async () => [{ count, retryAfterMs: 10_000 }] }),
    sourceTransform: (file, source) => file.endsWith("deepinfraNetwork.ts")
      ? "export function deepinfraFetch(url, init) { return fetch(url, init); }"
      : source,
  });
  const originalKey = process.env.DEEPINFRA_API_KEY;
  process.env.DEEPINFRA_API_KEY = "synthetic-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = originalKey;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    hits++;
    assert.equal(url, "https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo");
    assert.equal(options.headers.Authorization, "Bearer synthetic-key");
    const file = options.body.get("audio");
    assert.equal(file.type, "audio/wav");
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    return Response.json(upstream);
  });
  const { POST } = load(join(root, "src/app/api/voice-input/route.ts"));
  const audio = Buffer.alloc(16_000);
  audio.writeInt16LE(2_000, 0);
  const request = (body = audio, headers = {}) => new Request("https://example.test/api/voice-input", {
    method: "POST", body, headers: {
      "Sec-Fetch-Site": "same-origin", "Content-Type": "application/octet-stream", ...headers,
    },
  });

  assert.equal((await POST(request(audio, { "Sec-Fetch-Site": "cross-site" }))).status, 403);
  session.userId = null;
  assert.equal((await POST(request())).status, 401);
  session.userId = "synthetic-user";
  assert.equal((await POST(request(audio, { "Content-Type": "audio/wav" }))).status, 415);
  assert.equal((await POST(request(audio, { "Content-Length": "960001" }))).status, 413);
  assert.equal((await POST(request(Buffer.alloc(960_002)))).status, 413);
  assert.equal((await POST(request(Buffer.alloc(16_001)))).status, 400);
  assert.equal((await POST(request(Buffer.alloc(512)))).status, 422);
  assert.equal((await POST(request(Buffer.alloc(16_000)))).status, 422);
  count = 61;
  const limited = await POST(request());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "10");
  assert.equal(hits, 0);
  count = 1;
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { text: "This is a test." });
  upstream = { text: "" };
  assert.equal((await POST(request())).status, 422);
  assert.equal(hits, 2);
});

test("the audio worklet resamples input, caps the recording and sends exactly once", () => {
  let Processor;
  const events = [];
  runInNewContext(readFileSync(new URL("../public/voice-input-worklet.js", import.meta.url), "utf8"), {
    sampleRate: 48_000,
    AudioWorkletProcessor: class {
      port = { postMessage: buffer => events.push(new Int16Array(buffer)) };
    },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const recorder = new Processor({ processorOptions: { maxSamples: 3, targetRate: 16_000 } });
  assert.equal(recorder.process([[Float32Array.from([0.5, 0.5, 0.5, -1, -1, -1])]]), true);
  assert.equal(recorder.process([[Float32Array.from([1, 1, 1, 1, 1, 1])]]), false);
  recorder.port.onmessage();
  assert.equal(events.length, 1);
  assert.deepEqual([...events[0]], [16_383, -32_768, 32_767]);
});
