# P0/P1 rework: статус по требованиям

Дата: 1 октября 2026. Продакшен-миграции, боевые списания, ротация прод-секретов и релиз **не выполнялись**. Живые цены не менялись: Диалог 499 ₽ / 2 500 VC, История 1 299 ₽ / 10 000 VC, Вселенная 3 499 ₽ / 30 000 VC.

Статус в каждой строке: **исправлено и проверено** / **исправлено, проверка не выполнена** / **осталось**.

## 1. P0 — секреты и логи

| Требование | Статус | Что сделано / чем проверено | Осталось |
| --- | --- | --- | --- |
| Убрать реальные секреты из рабочего дерева и verify-скрипта | **исправлено и проверено** | `scripts/verify-p0-p1.ts` сканирует AST/файлы без литералов секретов. `npm run verify:p0-p1` — 39 checks. `npm run verify:p0-p1:repro` — «repaired retry/revoke/redaction expectations hold». | Значения, уже попавшие в git history, этой правкой не удалены. |
| Fail-closed env без DSN в ошибке | **исправлено и проверено** | `getRequiredEnv` называет только имя переменной. Unit-check с синтетическим `NV_P0P1_MISSING_*`. | — |
| Redact Error.message, Prisma/Axios, DSN, циклы | **исправлено и проверено** | `src/lib/redactSensitive.ts` + logger. Unit: nested, Error.message, prisma-like, cycle. Account.create больше не печатает сырой error object. | Прямые `console.*` в `src/lib/prisma.js` ensure-ветках и части auth-логов остаются; поля id/provider печатаются без токенов. |
| Ротация production NEXTAUTH_SECRET и пароля БД | **осталось** | Порядок ниже. P0 **не закрыт**. | Нужно подтверждение владельца после ротации в RelaxDev. |

## 2. P1 — гостевой запрос, лимит, retry

| Требование | Статус | Что сделано / чем проверено | Осталось |
| --- | --- | --- | --- |
| Атомарный claim quota+request, fencing, lease | **исправлено и проверено** | `guestRequestStore.claimGuestGeneration` в транзакции. Интеграция: параллельный create → один runner; failed retry → один runner; stale attempt не финализирует. `npm run verify:p0-p1:int` — 37 checks на изолированном PostgreSQL 18 (embedded, `127.0.0.1:55432/nv_p0p1_test`). | Не проверялся обрыв процесса mid-stream против реального Kodik. |
| Replay completed и последнего бесплатного | **исправлено и проверено** | Unit policy + интеграция: replay без роста quota; 5-е сообщение и его replay при quota 0. | — |
| Не доверять `body.history` | **исправлено и проверено** | История только из `AnonymousMessage`. Unit: исходник не читает `body.history`. | Браузерная подстановка spoofed history не гонялась (нет TEST_BASE_URL). |
| AI вне транзакции БД | **исправлено, проверка не выполнена** | Код: claim → сеть/stub → finalize. | Реальный стрим Kodik в этой сессии не вызывался. |
| TTL 7 дней, quota 5 | **исправлено и проверено** | Unit TTL/cookie. | Cleanup cron против прод-данных не запускался. |

## 3. P1 — перенос и отзыв

| Требование | Статус | Что сделано / чем проверено | Осталось |
| --- | --- | --- | --- |
| Revoke после transfer, cookie clear на любом успешном POST | **исправлено и проверено** (сервер) | Интеграция: revoke guest claim; idempotent transfer; чужой user → `foreign_session`; live pending → `in_progress`. Cookie чистится в `POST /api/anonymous/transfer` при `ok: true`, включая alreadyTransferred. | Браузер: JWT→POST→logout не прогнан. Google/email OAuth не проверялись. |
| Не копировать pending, только completed | **исправлено и проверено** | Policy + transfer SQL. | — |
| callbackUrl allowlist | **исправлено и проверено** | Unit: `//`, `%2f%2f`, backslash, `/login`. | Реальный Google redirect не проверялся. |

## 4. P1 — платежи и тарифы

| Требование | Статус | Что сделано / чем проверено | Осталось |
| --- | --- | --- | --- |
| Unique PaymentEvent + атомарное начисление | **исправлено и проверено** | Три параллельных grant → одно начисление 100 VC. Дубликат ловится unique. Webhook ветки: `commitPaymentGrant` возвращает `OK{invId}` на duplicate. | HTTP webhook с боевой/тестовой подписью Robokassa не отправлялся. |
| Backfill исторических InvId | **исправлено и проверено** | Fixture `Robokassa InvId=999001` + повторный backfill inserted=0. SQL миграции `20261001180000`. | Прод-backfill не применялся. |
| SuccessURL ≠ оплата; статус по своему PaymentEvent | **исправлено, проверка не выполнена** | `/api/payment/status` смотрит PaymentEvent своего userId. Баннер pending/waiting + ссылка в поддержку. | Браузер pending→webhook→confirmed не прогнан. |
| Калькулятор из каталога, без 4/36 | **исправлено и проверено** | Unit: пустой каталог unavailable; интеграция: Cheap 4 VC → 625 запросов на 2500 VC. UI читает `/api/models`. | Смена модели в браузере на `/pricing` не снималась скрином. |
| Живые цены/VC | **исправлено и проверено** | Unit Universe 3499. `chatEconomy.ts` не менялся по суммам. | — |

## 5. P1 — поддержка, аналитика, миграции

| Требование | Статус | Что сделано / чем проверено | Осталось |
| --- | --- | --- | --- |
| clientKey replay / conflict | **исправлено и проверено** | Интеграция create/replay/conflict. | Форма в браузере не прогнана. |
| Outbox, claim, backoff, stale sending | **исправлено и проверено** | Интеграция: Resend stub fail → failed; повтор claim в будущем now → sent. Cron `/api/cron/deliver-support`. | Cron на проде не включался. |
| SUPPORT_INBOX_EMAIL без личного fallback | **исправлено и проверено** | `getRequiredEnv("SUPPORT_INBOX_EMAIL")`. | — |
| Rate-limit не ломает replay; не доверять x-forwarded-for без TRUST_PROXY | **исправлено, проверка не выполнена** | Replay по clientKey до лимита; DB count по email; `TRUST_PROXY`. | Лимит в памяти (`consumeRateLimit`) по-прежнему не общий между инстансами, кроме счётчика тикетов по email. |
| Login attempt vs success | **исправлено, проверка не выполнена** | Credentials: `loginAttempt` до ответа, `login` после успеха. Google click → только `loginAttempt`. | Успех Google после OAuth callback не шлётся отдельной целью. |
| Нет runtime DDL в guest/support | **исправлено и проверено** (новые пути) | `ensureAnonymousChatTables` только SELECT. Интеграция: роль `nv_p0p1_app` читает таблицы и не может CREATE TABLE. | `src/lib/prisma.js` всё ещё делает `ALTER TABLE` slug / notification / email verification при работе суперпользователя. |
| Чистая схема + upgrade 20261001180000 | **исправлено и проверено** | Isolated `prisma db push` (pgvector в embedded Postgres нет — для push `vector(1536)` заменён на Bytes **только во временной копии schema**). Upgrade: сброс новых колонок → SQL `20261001180000` → payloadHash и PaymentEvent. Полный `migrate deploy` с пустой БД **не проходит**: нет baseline-миграции с `User`. | Прод-migrate не выполнялся. |

## 6. Экономика (раздел 6 задания)

| Требование | Статус | Где |
| --- | --- | --- |
| Воспроизводимый расчёт 3+ вариантов × 4 сценария | **исправлено и проверено** | `npm run economy:acquisition` → `docs/universe-acquisition-economy.md` и `.json` (20 строк: control, guest10, daily20, premiumTrial, firstPack129 × low/medium/high/stress). |
| RAG OR-флаг | **исправлено и проверено** | `src/lib/ragEligibility.ts`; unit и calculator assert. |
| Не менять живые условия | **исправлено и проверено** | Калькулятор гипотез, A/B не включался. |
| Один рекомендуемый эксперимент | **исправлено и проверено** | Разовый пакет 129 ₽ без автопродления; VC из COGS; 28 дней + окно продления. |

Прежние 25,1%/17,6% **не** названы гарантированной прибылью. Входы без telemetry помечены как assumption.

## 7. Проверки (факт)

| Команда | Результат |
| --- | --- |
| `npm run verify:p0-p1` | Passed 39 checks |
| `npm run verify:p0-p1:repro` | repaired expectations hold |
| `npm run verify:p0-p1:int` | Integration passed 37 checks; изолированный PostgreSQL 18 embedded, БД `nv_p0p1_test`, не `DATABASE_URL` приложения |
| `npm run verify:p0-p1:browser` | SKIP: `TEST_BASE_URL` не задан. Браузер к прод-БД не подключался |
| `npx tsc --noEmit` | passed |
| `npm run lint` | команда есть; 27 errors / 25 warnings, в основном pre-existing `react-hooks/set-state-in-effect` и `<img>` |
| `npm run build` | passed (`next build`, 2026-10-01) |
| `npm run economy:acquisition` | 20 rows written |

## Браузерные сценарии

**осталось.** Скрипт `scripts/browser-p0-p1.ts` готов (гость, cookie, support ticketId/replay, pricing без «приоритетной очереди», RU/EN). Не запускался против живого приложения: Docker отсутствует, отдельный Next на тестовой БД не поднимался, чтобы не задеть production `DATABASE_URL` из локального `.env`. Цепочка guest → refresh → register/login → transfer → logout, оплата pending→webhook, поддержка в UI — не подтверждены браузером.

## Runtime / выпуск (когда будет команда владельца)

1. Ротация `NEXTAUTH_SECRET` (инвалидирует старые сессии) и пароля PostgreSQL; обновить `DATABASE_URL`/`DIRECT_URL` с `connection_limit`.
2. Применить миграции `20261001120000_guest_chat_and_support` и `20261001180000_p0_p1_rework` на выделенной копии, затем на прод **отдельной командой**. Откат приложения не DROP-ает новые таблицы.
3. Env: `SUPPORT_INBOX_EMAIL`, `TRUST_PROXY=1` только за известным прокси, `CRON_SECRET`.
4. Cron: `/api/cron/cleanup-anonymous`, `/api/cron/deliver-support`.
5. Smoke: гость → reload → логин с безопасным callbackUrl; `/pricing` ориентир из каталога; SuccessURL показывает pending; `/support` возвращает ticketId.
6. Не включать экономические гипотезы в публичные тарифы.

## P0 остаётся открытым до ротации секретов в production.
