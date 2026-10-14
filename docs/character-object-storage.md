# Character media in Yandex Object Storage

New editor uploads, inline images submitted on character creation/update, reference
images (`imageLora`) and completed Kie avatars are saved in the private
`newverse-character-media` bucket. Text fields remain in PostgreSQL.

Configure the five server-only `S3_*` variables documented in `.env.example`.
The credentials belong to `newverse-media`, with `storage.editor` scoped to this
bucket. Missing configuration or a failed storage write returns an error; new
images never silently fall back to base64 in PostgreSQL.

The database and editor receive stable references of the form
`/api/character-media/<owner>/<asset>`. Objects use
`characters/<owner>/<asset>.webp`. Raster images are decoded, oriented, reduced to
at most 1536 px per side and encoded as WebP. Manual input is limited to 5 MiB;
multipart requests also have an actual streamed byte limit.

`/api/characters/<id>/avatar` preserves character visibility checks and redirects
to a signed download from Yandex. Draft previews are accessible to the uploader;
publicly attached files can be viewed anonymously. Redirects are not cached, and
signed URLs expire after five minutes. A previously issued URL remains usable
until expiry, even if the character becomes private.

The browser never receives static S3 credentials. Public buckets, browser-side
S3 writes, and CORS configuration are unnecessary for this implementation.

Legacy inline avatars still render. Saving an inline avatar again moves it into
storage. A mass migration of existing cards and cleanup of abandoned uploads are
separate tasks; this change does not remove users' old media.

## Verification

- `npm run verify:characters:storage`: actual route handlers with isolated fixtures.
- `GUEST_TEST_RUNTIME=<embedded-postgres-installation> node scripts/verify-character-storage.mjs --live`:
  real Yandex uploads/downloads and actual route handlers with a disposable local
  PostgreSQL instance. It refuses production database URLs, stubs authentication,
  translation and the provider image response, and removes only its test objects.
- `npm run verify:avatars:kie`: generation, quota and retry regressions on isolated
  PostgreSQL with simulated provider and S3 responses.
- `npm run build`: production compilation and TypeScript checks.

The live verification report is `docs/character-storage-verification.json`. Keys
and signed URLs are omitted from the report. Applying this to the live website
requires deploying the code together with the saved S3 environment variables.
