# Automatic character batches

Admin page: `/ru/admin/character-generation` (also available with the English
locale prefix). Sign in as the owner of the drafts, then enter `ADMIN_SECRET`.
The secret stays in page memory, never local storage or a URL. Every administrative
request verifies both the secret and the logged-in owner. The page is not indexed.

The first party uses the ten original themes in
`src/lib/data/character-generation-themes.json`, selected from the reviewed public
catalogue and competitor themes. Defaults: ten Russian cards, automatic English
translations, private drafts, maximum batch budget 200 RUB. A smaller party and
budget can be selected. Text generation uses Qwen 3 235B on DeepInfra independently
of the chat/memory model; images use the existing Kie Seedream text model.

## Deployment

1. Apply the additive SQL migration
   `prisma/migrations/20261014110000_character_generation_batches/migration.sql`.
   `node scripts/apply-character-generation-migration.mjs` applies only this
   migration and records its checksum in an existing Prisma migration ledger.
   It refuses a partially installed or unrecorded schema. Use `MIGRATION_DATABASE_URL`
   or `DIRECT_URL` when runtime uses a connection pool.
   For a pre-existing manually managed schema without `_prisma_migrations`, run
   only this SQL file in one explicit transaction in the database editor after
   checking that all three generation tables are absent. Do not initialize a
   partial Prisma history or run all historical migrations against that schema.
   The production database received this additive migration through Adminer on
   2026-10-14; all 247 existing characters remained present. Its provenance and
   SQL checksum are stored in the `CharacterGenerationBatch` table comment.
2. Deploy the code with the regenerated Prisma client (`npm run build`).
3. Configure `ADMIN_SECRET`, `CRON_SECRET`, `DEEPINFRA_API_KEY`,
   `DEEPINFRA_USD_RUB` (actual RUB paid per USD), `KIE_API_KEY`,
   `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, and the existing five `S3_*` variables.
   `YANDEX_TRANSLATE_COST_RUB_PER_MILLION_CHARS` defaults to the reviewed 500.4 RUB.
4. Start with `npm start` or the Docker entrypoint. The startup wrapper polls an
   authenticated loopback endpoint and processes one durable stage at a time.
   No external scheduler is necessary. `CHARACTER_GENERATION_WORKER_ENABLED=0`
   disables this internal worker; an external scheduler may instead POST to
   `/api/cron/generate-characters` with `Authorization: Bearer CRON_SECRET`.
   Set `CHARACTER_GENERATION_EXTERNAL_WORKER_ENABLED=1` only after configuring
   that scheduler, so the page allows starting batches with the internal worker off.

The dev wrapper does not automatically launch paid work. Production defaults
enable the worker, but no provider is called until an administrator starts a party.

## Durable stages and budget

PostgreSQL stores batches, individual jobs and paid-attempt reservations. Workers
claim leased items with `FOR UPDATE SKIP LOCKED`; shared batch row locks serialize
budget reservations. Each paid request reserves a conservative quote before the
network call. Completed attempts settle by usage/character count or Kie credits;
unknown responses retain their complete reserved cost. An observed charge above
its quote pauses the party for tariff review. Displayed costs are estimates based
on the frozen batch tariffs, not provider invoices. The budget excludes ongoing
storage and download bills after the initial run.

Stages: create text → validate editor limits/tags/duplicates → review consistency
with a separate model request → submit avatar → poll the same provider task → save
WebP in Object Storage → translate and checkpoint each field → save one draft.
The system prompt is assembled by the existing roleplay builder. Text and image
generation retries are bounded to two attempts per stage; translation retries are
bounded per field. Failed stages can be retried from the page within those limits.

A lost image-submit response is never automatically resubmitted. The administrator
can recover its task ID from Kie history and continue polling the already paid job.
Storage failures retry downloading/saving the existing image, not generating it.
Closing the page has no effect on the server worker. Pausing finishes an already
running request and prevents subsequent paid stages; restarting the server restores
progress and conservatively accounts for interrupted requests.

Draft creation and its job checkpoint share a transaction. The character ID is
derived from the job ID, making save retries idempotent. Published status changes
only when the administrator chooses Publish (or edits the card normally).
Avatar generation for catalog batches does not use user quota reservations or VC.

## Verification

`GUEST_TEST_RUNTIME=<embedded-postgres-runtime> npm run verify:characters:generation`
uses actual PostgreSQL transactions and route handlers with simulated paid
providers/storage. It exercises all ten cards, administrative access, migration,
cost ceilings, parallel workers, pause/resume, lost task recovery, restarts, bounded
repairs, partial translations, publication and the background loop.

`docs/character-generation-verification.json` contains the result and explicitly
identifies the simulated paid services. No production database or paid provider is
used by this suite. The earlier Object Storage suite verifies actual Yandex uploads.
