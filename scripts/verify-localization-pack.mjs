import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./lib/load-local-module.mjs";
import { protectTranslation, restoreTranslation, splitTranslationText, translationImportSql, adaptPluralForms, applyReviewedCharacterFields, dictionaryFromTranslations } from "./lib/localization-pack.mjs";

const text = '<0>Hello {{name}}</0>\nNewVerse & VC https://example.test/path?q=1';
assert.deepEqual(dictionaryFromTranslations({ paragraphs: ['Hello'], faq: [{ question: 'Why?', answer: 'Because.' }], numericObject: { '0': 'Zero' }, empty: [] }, {
  'paragraphs.0': 'Olá', 'faq.0.question': 'Porquê?', 'faq.0.answer': 'Porque sim.', 'numericObject.0': 'Zero',
}), { paragraphs: ['Olá'], faq: [{ question: 'Porquê?', answer: 'Porque sim.' }], numericObject: { '0': 'Zero' }, empty: [] });
assert.throws(() => dictionaryFromTranslations({ faq: ['Question'] }, {}), /Missing or invalid translated leaf/);
assert.deepEqual(adaptPluralForms({ message_one: 'mensaje', message_other: 'mensajes' }, 'es-ES'), { message_one: 'mensaje', message_other: 'mensajes', message_many: 'mensajes' });
const protectedValue = protectTranslation(text);
assert.equal(restoreTranslation(protectedValue.text.replace('Hello', 'Hola'), protectedValue.tokens), text.replace('Hello', 'Hola'));
assert.throws(() => restoreTranslation(protectedValue.text.replace('__NV_KEEP_0__', ''), protectedValue.tokens));
const long = ('a long sentence {{name}} with details.\n').repeat(200);
const pieces = splitTranslationText(long);
assert.equal(pieces.join(''), long);
assert.ok(pieces.every(piece => piece.length <= 1400));
assert.ok(pieces.every(piece => !piece.includes('{{') || !piece.endsWith('{{name')));
const fields = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt", "publicMemory"];
const source = Object.fromEntries(fields.map(field => [field, field === 'publicMemory' ? { content: 'Public facts' } : field === 'name' ? "O'Neil; DROP TABLE Character;" : null]));
const row = { characterId: 'public', locale: 'es', sourceHash: 'a'.repeat(64), ...Object.fromEntries(fields.map(field => [field, field === 'name' ? 'Nombre' : null])), source };
const edited = { ...row, greeting: 'Hello {{user}}' };
applyReviewedCharacterFields(edited, {sourceHash:row.sourceHash,fields:{greeting:'Hola {{user}}'}});
assert.equal(edited.greeting,'Hola {{user}}');
assert.throws(()=>applyReviewedCharacterFields(edited,{sourceHash:'b'.repeat(64),fields:{greeting:'Hola {{user}}'}}),/Outdated editorial/);
assert.throws(()=>applyReviewedCharacterFields(edited,{sourceHash:row.sourceHash,fields:{privateMemory:'private'}}),/Invalid reviewed character field/);
assert.throws(()=>applyReviewedCharacterFields(edited,{sourceHash:row.sourceHash,fields:{greeting:'Hola'}}),/changed variables/);
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE "Character" (id text PRIMARY KEY, "isPublic" boolean NOT NULL, ${fields.map(field => `"${field}" ${field === 'publicMemory' ? 'jsonb' : 'text'}`).join(',')});`);
  await db.exec(readFileSync('prisma/migrations/20261028120000_character_translations/migration.sql','utf8'));
  const pipelineMigration=readFileSync('prisma/migrations/20261029140000_character_translation_pipeline/migration.sql','utf8');
  await db.exec(pipelineMigration);await db.exec(pipelineMigration);
  await db.query('INSERT INTO "Character" (id,"isPublic",name,"publicMemory") VALUES ($1,true,$2,$3),($4,false,$2,$3),($5,true,$6,$3)', ['public',source.name,JSON.stringify(source.publicMemory),'private','changed','Edited']);
  const results = await db.exec(translationImportSql([row,{...row,characterId:'private'},{...row,characterId:'changed'}],fields));
  const summary = results.find(result => result.rows?.[0]?.prepared !== undefined).rows[0];
  assert.deepEqual(summary,{prepared:3,saved:1,changed_or_unpublished:2});
  assert.equal((await db.query('SELECT name FROM "CharacterTranslation"')).rows[0].name,'Nombre');
  await db.exec(translationImportSql([{...row,name:'Nuevo'}],fields));
  assert.equal((await db.query('SELECT name FROM "CharacterTranslation"')).rows[0].name,'Nuevo');
  await db.exec(translationImportSql([{...row,name:'Reviewed'}],fields,{pipelineHash:'c'.repeat(64)}));
  const metadata=(await db.query('SELECT "pipelineHash","qualityReviewedAt" FROM "CharacterTranslation"')).rows[0];
  assert.equal(metadata.pipelineHash,'c'.repeat(64));assert.ok(metadata.qualityReviewedAt);
  await db.exec(translationImportSql([{...row,name:'Legacy'}],fields));
  assert.deepEqual((await db.query('SELECT "pipelineHash","qualityReviewedAt" FROM "CharacterTranslation"')).rows[0],{pipelineHash:null,qualityReviewedAt:null});
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM "Character"')).rows[0].count,3);
} finally { await db.close(); }
const app = moduleLoader({ "next/navigation": { usePathname: () => "/es/chat/fixture" } });
const dictionary = app("src/lib/getDictionary.ts");
assert.equal(dictionary.translate("es", "chatUi.text053"), "Tu turno…");
assert.equal(dictionary.translate("es", "chatUi.text054"), "Enviar");
assert.equal(dictionary.translate("es", "home.hero.catalogCount_one", { count: 1 }), "1 personaje en el catálogo");
const provider = app("src/components/I18nProvider.tsx").default;
const composer = app("src/components/ChatComposer.tsx").default;
const switcher = app("src/components/LanguageSwitcher.tsx").default;
const markup = renderToStaticMarkup(createElement(provider, { locale: "es" }, createElement(composer, { value: "Hola", onChange() {}, onSubmit() {}, disabled: false, canSend: true }), createElement(switcher)));
assert.ok(markup.includes("Tu turno…") && markup.includes("Enviar") && markup.includes("Español"));
assert.ok(!markup.includes("Ваш ход") && !markup.includes("Отправить"));
assert.ok(app("src/lib/chatSystemPrompt.ts").assembleRoleplayPrompt({ name: "Maren" }, "es").content.includes("Always reply in Spanish"));
// A resumed job includes previous attempts in its budget and must fail before any request.
const checkpointDirectory = mkdtempSync(path.join(tmpdir(), "nv-translation-budget-"));
try {
  writeFileSync(path.join(checkpointDirectory, "es-cache.json"), JSON.stringify({version:1,values:{},characters:99,requests:1}));
  const run = spawnSync(process.execPath, ["--experimental-strip-types","--import","./scripts/alias-register.mjs","scripts/translate-localization-pack.mjs","--locale=es",`--workdir=${checkpointDirectory}`,"--max-total-characters=0","--apply"], {
    encoding:"utf8",env:{...process.env,YANDEX_API_KEY:"synthetic-budget-test",YANDEX_FOLDER_ID:"synthetic-budget-test"},
  });
  assert.equal(run.status,1);
  assert.ok(run.stderr.includes("including previous attempts; no requests sent"));
  assert.equal(JSON.parse(readFileSync(path.join(checkpointDirectory, "es-cache.json"), "utf8")).characters,99);
  // Simulate a transport failure without contacting the provider. Its possible charge must remain reserved.
  writeFileSync(path.join(checkpointDirectory, "es-cache.json"), JSON.stringify({version:1,values:{},characters:0,requests:0}));
  const transportFixture=path.join(checkpointDirectory,"reject-fetch.mjs");
  writeFileSync(transportFixture,'globalThis.fetch = async () => { throw new Error("synthetic transport timeout"); };');
  const failed = spawnSync(process.execPath,["--experimental-strip-types","--import","./scripts/alias-register.mjs","--import",pathToFileURL(transportFixture).href,"scripts/translate-localization-pack.mjs","--locale=es",`--workdir=${checkpointDirectory}`,"--max-total-characters=1000000","--apply"],{
    encoding:"utf8",env:{...process.env,YANDEX_API_KEY:"synthetic-budget-test",YANDEX_FOLDER_ID:"synthetic-budget-test"},
  });
  assert.equal(failed.status,1);
  assert.ok(failed.stderr.includes("synthetic transport timeout"));
  const failedCheckpoint=JSON.parse(readFileSync(path.join(checkpointDirectory,"es-cache.json"),"utf8"));
  assert.equal(failedCheckpoint.requests,1);
  assert.equal(failedCheckpoint.unconfirmedRequests,1);
  assert.ok(failedCheckpoint.characters>0 && failedCheckpoint.characters<=9500);
} finally {
  const allowedParent = path.resolve(tmpdir()) + path.sep;
  if(!path.resolve(checkpointDirectory).startsWith(allowedParent) || !path.basename(checkpointDirectory).startsWith("nv-translation-budget-")) throw new Error("Unexpected checkpoint cleanup directory");
  rmSync(checkpointDirectory,{recursive:true,force:true});
}
console.log('PASS protected variables/markup, lossless segmentation, SQL parameter encoding, private-card exclusion, source-change guards and idempotent import');
