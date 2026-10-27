import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const callbacks = [], errors = [], cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  const module = { exports: {} };
  cache.set(file, module.exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function("require", "module", "exports", code)((name) => {
    if (name === "next/server") return { after: callback => callbacks.push(callback) };
    if (name === "./logger") return { errorLog: (...args) => errors.push(args) };
    if (name.startsWith("@/") || name.startsWith(".")) {
      const path = name.startsWith("@/") ? join(root, "src", name.slice(2)) : resolve(dirname(file), name);
      return load(path.endsWith(".json") ? path : `${path}.ts`);
    }
    return require(name);
  }, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}

const { indexNowChangeUrls, scheduleIndexNowChange } = load(join(root, "src/lib/indexNow.ts"));
const publicCard = { name: "Mage", isPublic: true, slug: "forest-mage-123" };
const privateCard = { ...publicCard, isPublic: false, slug: "private-unpublished-sentinel" };
assert.deepEqual(indexNowChangeUrls(null, privateCard), []);
assert.deepEqual(indexNowChangeUrls(privateCard, { ...privateCard, name: "edited" }), []);
for (const field of ["description", "description_en", "descriptionCard", "descriptionCard_en", "tags", "greeting", "scenario", "publicMemory", "publicMemory_en"]) {
  assert.deepEqual(indexNowChangeUrls(null, { ...publicCard, [field]: "18+" }), []);
}
assert.deepEqual(indexNowChangeUrls(null, { ...publicCard, slug: "../profile?secret=1" }), []);
assert.deepEqual(indexNowChangeUrls(null, { ...publicCard, slug: "" }), []);
const created = indexNowChangeUrls(null, publicCard);
assert.equal(created.length, 6);
assert(created.includes("https://newvers.ai/ru/character/forest-mage-123"));
assert(created.includes("https://newvers.ai/en/character/forest-mage-123"));
assert.deepEqual(indexNowChangeUrls(privateCard, publicCard), created);
assert.deepEqual(indexNowChangeUrls(publicCard, privateCard), created);
assert.deepEqual(indexNowChangeUrls(publicCard, null), created);
assert.equal(indexNowChangeUrls(publicCard, { ...publicCard, slug: "new-name" }).length, 8);
assert.equal(indexNowChangeUrls(publicCard, publicCard).length, 6);

const originalFetch = globalThis.fetch, originalMode = process.env.NODE_ENV;
try {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, ...init }); return new Response(null, { status: 202 }); };
  process.env.NODE_ENV = "development";
  scheduleIndexNowChange(null, publicCard);
  assert.equal(callbacks.length, 0);
  process.env.NODE_ENV = "production";
  scheduleIndexNowChange(null, privateCard);
  assert.equal(callbacks.length, 0);
  scheduleIndexNowChange(null, publicCard);
  assert.equal(callbacks.length, 1);
  assert.equal(sent.length, 0, "No work before the response finishes");
  await callbacks.shift()();
  assert.equal(sent[0].url, "https://api.indexnow.org/indexnow");
  const payload = JSON.parse(sent[0].body);
  assert.deepEqual(payload.urlList, created);
  assert.equal(readFileSync(join(root, `public/${payload.key}.txt`), "utf8"), payload.key);
  assert.equal(payload.keyLocation, `https://newvers.ai/${payload.key}.txt`);
  assert(!sent[0].body.includes("private-unpublished-sentinel"));
  globalThis.fetch = async () => new Response("DO_NOT_LOG_RESPONSE", { status: 429 });
  scheduleIndexNowChange(publicCard, null);
  await callbacks.shift()();
  assert(errors.flat().includes("Submission returned HTTP 429"));
  globalThis.fetch = async () => { throw new Error("DO_NOT_LOG_SECRET"); };
  scheduleIndexNowChange(null, publicCard);
  await callbacks.shift()();
  assert(!JSON.stringify(errors).includes("DO_NOT_LOG"));
} finally {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalMode;
}
console.log("PASS: IndexNow public/private transitions, noindex filtering, renames, deletion notices, production-only background sending, live key file and safe failure handling.");
