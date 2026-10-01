# Отчёт: закрытие P0 по секретам и логированию

Дата: 1 октября 2026. Задание: `docs/cursor-p0-security-only-task.md`. Повтор после независимого ревью исправлений (`docs/p0-security-independent-review.md`).

## Статусы

- **P0: код и проверки** — предыдущие воспроизведения и оставшийся обход `errorLog` (message-only / name+message / вложенный error) закрыты в этой копии. Приёмка кода — если `docs/p0-security-second-independent-repro.mjs` больше не показывает leaked=true. Это не закрытие общего P0.
- **P0: production-ротация** — pending. Оператору: `docs/p0-security-rotation-runbook.md`. Общий P0 **не закрыт**, пока нет подтверждения ротации.
- Метрика, цели покупки, цены, VC, экономика, платёжная бизнес-логика, гостевые лимиты/перенос, поддержка и UX **не изменялись**. Production-ротация, миграции, релиз, списания, письма, живой OAuth и перепись git history **не выполнялись**. Коммит/push не делались.

## Что утекало и что сделано

Первый проход (синтетические значения из задания):

- `Authorization: Bearer …` оставлял токен после слова Bearer.
- `password="…"` в кавычках не маскировался.
- DSN и `token=` в одной строке: ранний return после DSN.
- Циклический массив: `RangeError`, массив обходился до WeakSet.

Повторное ревью (1 октября 2026):

- Сырые `console.error(error)` в register / reset-password / forgot-password и subscription catch; sitemap печатал Prisma init error; forgot-password логировал полный email.
- `toSafeDiagnostic` = `redactSensitive`: обычный объект `{message,stack,meta}` и thrown-string сохраняли содержимое.
- JSON `{"password":"…"}` обходил ASSIGNED_SECRET из‑за кавычки между ключом и `:`; Robokassa логировала `responseText`; renew summary печатал `results[].error`.
- Сканер обходил фиксированные каталоги, `your_` делал всю строку placeholder, ошибка чтения = skip; корневой untracked JSON с `sk_live_` не находился.

Третье ревью (1 октября 2026, повторная приёмка):

- `errorLog` принимал `{message}`, `{name,message}` без stack и `{userId, error}` как обычный контекст; register/reset/resend ловили unknown без `toSafeDiagnostic`.
- Сканер отказывал staged-удалению (`git show :path` для D).

Исправления (этот проход):

- Catch P0-мест вызывают `toSafeDiagnostic` отдельно от `{userId}`; unknown error не вкладывается в контекст.
- `errorLog` больше не отличает ошибку от контекста эвристикой envelope: в контексте только allowlist ключей; поля message/stack/error/… всегда через `safeErrorFields`.
- Сканер: staged blobs `--diff-filter=ACMR`; удаления `--diff-filter=D` не читаются как blob.

- `src/lib/redactSensitive.ts` — Bearer, кавычки и JSON-ключи, несколько DSN/секретов, циклы, allowlist имён/кодов (`P####`, OAuth enum, HTTP codes); неизвестные name/code опускаются; неизвестные строки/объекты в `safeErrorFields` → `{ category: "error" }` без содержимого; getter/proxy → `{ category: "error" }` или `[unavailable]`.
- `src/lib/safeDiagnostics.ts` — `toSafeDiagnostic` только `safeErrorFields`, не `redactSensitive`.
- `src/lib/logger.ts` — error-канал отделяет текст сообщения и безопасный контекст от диагностики ошибок.
- Auth/subscription/sitemap catch → `errorLog`; forgot-password skip — домен, не адрес.
- `src/lib/robokassa.ts` — тела ответов не логируются; остаются событие, status, invId/recurringId.
- Cron renew summary — counts (`checked`/`renewed`/`failed`/`skipped`/`expiredCoins`), не текст `results[].error`.
- `scripts/verify-p0-security.ts` — Git tracked + untracked/staged текстовые файлы; read fail = fail; `your_` не маскирует строку; тесты handlers, JSON scrub, diagnostic contract и synthetic live-key fixture.

`.env*` по-прежнему в `.gitignore`; `.env.example` отслеживается.

## Изменённые файлы

- `src/lib/redactSensitive.ts`, `src/lib/logger.ts`, `src/lib/safeDiagnostics.ts`, `src/lib/cronAuth.ts`
- `src/lib/auth.ts`, `src/lib/prisma.js`, `src/lib/email.ts`, `src/lib/handlePrismaError.ts`, `src/lib/robokassa.ts`, `src/lib/subscriptionRenewal.ts`
- `src/app/api/auth/[...nextauth]/route.ts`, `register/route.ts`, `reset-password/route.ts`, `forgot-password/route.ts`
- `src/app/api/cron/*`, `src/app/api/payment/create/route.ts`, `webhook/route.ts`, `src/app/api/subscription/create/route.ts`, `cancel-recurring/route.ts`, `pending/cancel/route.ts`, `change/route.ts`
- `src/app/sitemap.ts`
- `.gitignore`, `package.json`
- `scripts/verify-p0-security.ts`, `scripts/verify-p0-p1.ts`
- `docs/p0-security-rotation-runbook.md`, `docs/p0-security-closure-report.md`

## Проверки

Изоляция: `verify:p0-security` не импортирует PrismaClient/auth options и не читает содержимое `.env`. Синтетические строки только в тесте. Runtime — перехват `console` и mock sink плюс transpile фактических handlers с mock Prisma/fetch.

Сканер коммит-кандидата берёт `git ls-files`, untracked и staged ACMR; staged deletions (`--diff-filter=D`) не читаются через `git show`. **Успех не доказывает отсутствие любых секретов.** Ошибка чтения существующих кандидатов — fail, не skip.

| Команда | Результат | Ограничение |
| --- | --- | --- |
| `npm run verify:p0-security` | 104 checks passed | Не ходит в БД, OAuth, почту, живую Robokassa; handlers с mock Prisma/fetch, включая message-only и thrown-string |
| `npm run verify:p0-p1` | 40 checks passed | policy/helpers, не браузер |
| `npx tsc --noEmit` | exit 0 | Типы, не runtime |
| `npx eslint --max-warnings 0` на изменённых файлах | exit 0 | Общий lint проекта не гонялся |
| независимый harness `docs/p0-security-independent-repro.mjs` | exit 0. Все leaked=false. live-key обнаружен (scannerExit=1) | Нет production credentials |
| независимый harness `docs/p0-security-second-independent-repro.mjs` | exit 0. Все leakedToConsole/leakedToSink=false, включая message-only, name+message, вложенную строку и реальные handlers | Exit 0 = воспроизведение сохранено, не закрытие P0 |
| `git diff --check` | exit 0 | whitespace |
| `npm run build` | exit 0; sitemap/DDL: `{category,name}` без сырого Prisma dump | Синтетические `DATABASE_URL`/`NEXTAUTH_SECRET`, БД `127.0.0.1:1`. Next сообщил о `.env`, процессные значения не перезаписывались. Успех сборки ≠ живая схема |

Не запускался `verify:p0-p1:int`. Не было production env rotation.

## Оставшееся

Production-ротация NEXTAUTH_SECRET и пароля БД — у оператора по runbook. Ротация отзывает credentials и не удаляет исторические копии. Прочие пункты повторного ревью (P1 гонки, поддержка, экономика, Метрика) вне этой задачи.
