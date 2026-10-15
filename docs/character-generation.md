# Automatic character batches

Admin page: `/ru/admin/character-generation` (also available with the English
locale prefix). Sign in as the owner of the drafts, then enter `ADMIN_SECRET`.
The secret stays in page memory, never local storage or a URL. Every administrative
request verifies both the secret and the logged-in owner. The page is not indexed.

Themes live in `src/lib/data/character-generation-themes.json`: the ten original
themes of the first party; then ten competitor-gap themes added on 2026-10-15 evening
(anime male leads — a captain, a tournament rival, a kitsune; an isekai summoner; a
male vampire; non-human comedy — a gargoyle, a merman; an elf mercenary; practical
helpers — an interview coach and a study buddy), placed first so the next party
takes them; then 30 themes added earlier that day for catalogue gaps (male
characters, comedy, thriller, horror, space, post-apocalypse, historical, villain,
rival) and the unused concepts from `character-strategy-2026-10-07.md`.
Each party takes the first themes this owner has not used yet; themes whose job
failed return to the pool, queued or uncertain ones do not. Defaults: ten Russian cards, automatic English
translations, private drafts, maximum batch budget 200 RUB. A smaller party and
budget can be selected. Text generation uses Qwen 3 235B on DeepInfra independently
of the chat/memory model. A second text attempt after a failed or lost request and an
explicit manual repair use Mistral Small 3.2; a second attempt after validation or
review feedback stays on Qwen. Consistency reviews use Qwen with a fixed checklist
(age, timeline, canon, scene, user agency, user gender, appearance, text); every
item must be `true`, and the failed item names go back to the text attempt. The
checklist fails only explicit violations: `avatarPrompt` must not contradict the
appearance (missing minor details are fine), image-quality words are allowed there,
and a dialogue reply may continue on following lines without a marker. Tags are not
a pass/fail item: the review lists unsupported tags, they are removed, and the card
is sent back only when fewer than three remain.

A suggested theme name that is already taken (public, owner's or a batch sibling) is
withheld from the prompt and named as forbidden. Duplicate feedback says whether the
name or the short description collided and with which character. Text output is
capped at 3200 tokens, with a target card size of 4500–5500 characters. Images use
the existing Kie Seedream text model.

## Deterministic card checks

`src/lib/characterGenerationChecks.ts` encodes the defects found in the 2026-10-14
paid batch. Repaired in place, without another paid request: tags given as an array,
aliases, legacy tags, more than eight tags, «Средневековье» next to modern details,
«Магическая академия» without a school, and dialogue labels such as `{{char}} —` or
the character's name. Rejected with a specific correction for the next text attempt:
placeholders like `[Имя]`, image-quality words outside `avatarPrompt`, repeated
words, missing `{{user}}:`/`{{char}}:` lines, a theme age missing from the appearance
or from the first `Возраст:` line of `canonicalNotes`, different eye or hair colours
in the appearance and `avatarPrompt`, and gendered address to the user.

Malformed or truncated JSON is a format correction for the primary model, not a lost
request. A failed card shows its last validator or review correction under
«Причина отказа» on the admin page.

`name_en` is a local transliteration, not a translation (Yandex turned «Руна Север»
into "The North Rune"). Before each field is translated, every inflected form of the
name is replaced with a Latin token and restored as the transliteration; if the
translator drops a token, the field is translated again without protection. In
`appearance_en`, pronouns follow the character's gender tag when the source describes
nobody else ("Her eyes" → "His eyes", "your left arm" → "his left arm").

Avatars: themes carry `artStyle` (`anime` for 10 of 40, otherwise realistic). The
avatar is drawn in that style, the card saves it, and anime cards get the «Аниме»
tag. Style and gloom words (photorealistic, 8k, dimly lit, muted tones…) are removed
from the card's `avatarPrompt` before it reaches the image model, and batch avatars
ask for a lively, well-lit face; realistic ones also ask for bright daylight, because
the realistic style line alone kept the 2026-10-15 photos dark and stern. Without a
gender tag, the gender for pronoun fixes comes from the Russian appearance pronouns. Each job also asks the text model for its own stable
set of distinctive features (face, hair, one detail), so men with "short dark-blond
hair" no longer share one stock face.

English fields reuse the `name_en` spelling of the name. Ready drafts show
non-blocking translation warnings on the admin page: numbers lost from the source,
pronouns that contradict the character's gender tag, and changed speaker markers.

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
Before any image is submitted, an administrator can explicitly request one manual
repair round for exhausted text/review jobs. It has separate `text_repair` and
`review_repair` attempt stages, still limited to two requests each. All earlier
attempts and charges remain in the same party and share its original budget.
Repair preserves a paused party and is never invoked by the automatic worker.
The fallback uses the reviewed USD rates 0.075 input / 0.20 output per million
tokens, frozen for new batches. Older batches use these rates only for new fallback
requests; their previously settled costs are not recomputed.

A lost image-submit response is never automatically resubmitted. The administrator
can recover its task ID from Kie history and continue polling the already paid job.
Storage failures retry downloading/saving the existing image, not generating it.
Closing the page has no effect on the server worker. Pausing finishes an already
running request and prevents subsequent paid stages; restarting the server restores
progress and conservatively accounts for interrupted requests.
Full card requests allow 270 seconds and consistency reviews 120 seconds. The
loopback request allows 300 seconds, the route declares 300 seconds, and item
leases last 420 seconds, keeping slow results fenced until their checkpoint.
A direct streamed measurement on 2026-10-15 gave Qwen 3.5 s to the first token
and ~14 tokens/s: a 1832-token card took 131 s, so the earlier 120-second limit
timed out every card and fell back to Mistral. The allvpn xray proxy has no policy
block, so its default 300-second idle limit stays above the text deadline.

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
