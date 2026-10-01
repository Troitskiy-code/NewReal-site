# Метрика покупок и цикл логгера — отчёт исправления

Дата: 1 октября 2026. Код изменён в рабочей копии. Commit/push, production-миграция, ротация P0, кабинет Яндекса и тестовые покупки в счётчик 112171267 не выполнялись.

Красная строка F12 `GET https://mc.yandex.ru/metrika/tag.js net::ERR_CONNECTION_CLOSED` не является критерием приёмки. Это загрузка внешнего счётчика; отказ primary может остаться в сети даже после успешного fallback. Блокировка домена не объявляется доказанной.

## Изменённые файлы этой задачи

Новые:

- `src/lib/metrikaLoader.ts` — загрузка tag.js, отдельный fallback-script, init с `triggerEvent`, готовность по `yacounter<id>inited`.
- `src/lib/purchaseGoalRuntime.ts` — pending-состояние, polling, dispatch с callback, межвкладочный lock.
- `prisma/migrations/20261001210000_payment_event_analytics/migration.sql` — nullable `PaymentEvent.planId` и `amountRub`.
- `scripts/verify-metrika.ts`, `scripts/browser-metrika.ts`.
- этот отчёт и `docs/metrika-owner-checklist.md`.

Основные правки:

- `src/components/YandexMetrika.tsx` — Client Component, `useEffect` → `startMetrikaLoader`; не `next/script` (onLoad/onReady требуют client, onReady повторяется при remount и сам по себе не даёт единственный init).
- `src/lib/metrika.ts` — `reachGoal` больше не считает queue success; `dispatchGoal` ждёт callback/timeout.
- `src/lib/goalTracking.ts` — один `PaymentGoalTracker` в `AppShell` (переживает уход со страницы планов).
- `src/components/SubscriptionPlans.tsx` — убран дублирующий `usePaymentGoal`.
- `src/components/PurchaseStatusBanner.tsx` — тот же invoice/status, что и аналитика.
- `src/app/api/payment/status/route.ts` — владельцу confirmed-события отдаются `kind`/`planId`/`amountRub`; чужой invoice → `pending` без утечки.
- `src/app/api/payment/webhook/route.ts` + `src/lib/paymentEvent.ts` — аналитические поля пишутся в существующей транзакции после проверки подписи; начисления/уникальность не менялись. `planId` для аналитики берётся только из `Shp_plan`, не из текущей подписки пользователя.
- `src/lib/logger.ts`, `scripts/verify-p0-security.ts` — seen/depth/budget до обхода массива/Map.
- `src/proxy.js` — после rewrite с `x-locale` повторный проход proxy не 307-зацикливает `/ru/...` → `/ru/...`. Нужно для реальной Next-навигации в Playwright; публичные URL и cookie-locale не менялись.
- `package.json` — `verify:metrika`, `verify:metrika:browser`, devDependency `playwright`.

Чужие незакоммиченные P0/docs и уже исправленный контракт безопасных логов сохранены.

## Состояния целей и политика retry

Состояния отдельной цели (`counterId + robokassa/invoiceId + имя цели`):

| Состояние | Смысл |
| --- | --- |
| `pending_confirmation` | есть invoice, сервер ещё не подтвердил PaymentEvent текущего пользователя |
| `ready_to_dispatch` | confirmed, счётчик готов или ожидается |
| `dispatched` | вызван `ym.reachGoal` (это ещё не доставка) |
| `callback_completed` | сработал callback API; финальный клиентский успех |
| `timeout` / `unknown` | callback не пришёл / сбой вызова |
| `skipped` | renewal или цель не применима |

Queue push ≠ sent. `sent=true` не пишется; в storage только явные состояния. Query оплаты снимается только после успешного persist в storage (иначе URL остаётся единственным восстановлением).

Retry:

- Polling: каждые 2 с, до 90 попыток в активном цикле; TTL pending 7 суток, максимум 8 invoice.
- Возобновление после 24 с: focus / online / pageshow / возврат на сайт снова дергает `/api/payment/status`. 401 и 5xx не становятся confirmed.
- Dispatch: до 3 попыток на цель, callback timeout 8 с, backoff 2–8 с.
- Успешный callback одной subscription-цели не переотправляется; вторая цель ретраится отдельно.
- Timeout после вызова `reachGoal` может означать, что Яндекс всё же принял хит, а клиент повторит → возможен дубль. Локальная дедупликация не является гарантией Яндекса.
- Logout / смена `userId` увеличивает generation; поздний async-ответ отменяется.
- `invoiceId=ok` отвергается (`normalizeInvId` только цифры).

Доход: `order_price`/`currency=RUB` только в основной цели (`subscription_success` или `vc_purchase_success`) из confirmed `OutSum`. Плановая цель без суммы. Если `amountRub` нет — поле опускается.

Renewal (`subscription_renewal`) не отправляет purchase-цели. Исторический event без `planId` даёт только `subscription_success`, без выдуманной плановой цели и без backfill из текущего тарифа.

## Миграция (зависимость выпуска)

SQL: `ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "planId" TEXT;` и `"amountRub" INTEGER`. Колонки nullable, исторические строки валидны без backfill.

Порядок:

1. Применить миграцию на целевой БД **до** выкладки кода, который читает/пишет `planId`/`amountRub`.
2. Затем выкатить приложение.
3. Не применять миграцию из агента на production.

Комментарий в `migration.sql` исправлен: раньше он требовал код «после» миграции в обратном порядке. Исторические строки остаются с NULL без backfill.

## Исправления после независимого ревью (1 октября 2026)

Четыре воспроизведённых P1 закрыты в runtime/баннере:

1. Баннер держит `bannerInvoiceId` / `bannerSession` текущего возврата; завершённый 203 не перекрывает pending 204. Logout и смена пользователя очищают баннер. Подписчики получают clone записи, а не мутабельный объект.
2. Хранилище изолировано по `counterId + userId`. Capture не переписывает чужой `userId`; pending от API сбрасывает локальный confirmed. Чужое confirmation не используется для баннера и dispatch.
3. Чтение сливает memory + sessionStorage + localStorage **по слотам целей** (max attempts, терминальный callback_completed, dispatched/timeout по времени слота); запись идёт в оба store независимо. Старый localStorage после QuotaExceeded не затирает `callback_completed` и не сбрасывает счётчик попыток.
4. Fallback-lock: JSON-lease с владельцем, окно конкуренции 20 мс после записи, renew до/после await и heartbeat на весь wait счётчика/callback/retry, release только своим owner. Второй вкладке без Web Locks работа не стартует, пока lease жив. Неатомарный read/set между вкладками не даёт CAS; гарантия ограничена владением lease.

## Исправления после второго независимого ревью (1 октября 2026)

Подтверждённые ранее сценарии (203→204, изоляция A/B, callback_completed при частичном quota, heartbeat lease, комментарий миграции) сохранены.

Оставшиеся P1/P2:

1. Полный отказ `localStorage.setItem` больше не роняет poll: межвкладочный lease отделён от обработки. Если lock нельзя записать, работает in-tab mutex + sessionStorage/память. URL снимается только если очередь и session-баннер реально сохранились.
2. Слияние идёт **по слотам целей**: max(attempts), терминальный `callback_completed`, `dispatched`/`timeout` по времени слота. Общий ранг записи больше не отменяет `maxDispatchAttempts`.
3. Смена generation/владельца отсекает persist до upsert/emit, включая ветки `http=0` и catch. Патч A не пишется в ключ B.
4. Активный баннер хранится в sessionStorage (`nv-metrika-banner:`), не в durable `bannerSession`. Reload той же вкладки восстанавливает возврат; новая вкладка и A→logout→A без query — idle.

`docs/metrika-second-review-probe.cjs` ожидает прежние остаточные дефекты и после фикса падает на первом из них (`fetches 1 !== 0`). Постоянные регрессии — в `verify:metrika` (91 check).

Исторический upgrade: `npm run verify:metrika:db` — PASS, `engine=pglite` (на машине нет Docker/`TEST_DATABASE_URL`; PGlite выполняет тот же SQL, что и Postgres-миграция, на изолированном движке). При наличии `TEST_DATABASE_URL` или контейнера `nv-p0p1-pg` / private `nv-p0p1-metrika-<pid>` используется настоящий Postgres; процессы на 55432 не убиваются. Браузерный mock `/api/payment/status` по-прежнему не заменяет проверку SQL; owner-check вынесен в `visiblePaymentStatus` и покрыт unit-тестом. Late webhook в browser suite ждёт >24 с (13 pending poll).


## Браузерные факты (Playwright, не кабинет)

Команда: `npm run verify:metrika:browser`. Next поднимался с синтетическими env (`NEXT_PUBLIC_YANDEX_METRIKA_ID=999001`, `DATABASE_URL=127.0.0.1:1`). Все `mc.yandex.com` / `mc.yandex.ru` перехватывались **до** `goto`. Боевой 112171267 не запрашивался. Mock tag.js: `init` + `yaCounter` + `yacounter<id>inited` + callback `reachGoal`.

Фактические проверки (18, exit 0):

- Primary: один `init`; RU VC → одна `vc_purchase_success`; EN dialog → `subscription_success` + `subscription_dialog` по серверному `planId`, query `type=vc&plan=universe` игнорируется; RU universe → success + `subscription_universe`.
- Primary abort (`connectionrefused`): **новый** запрос `mc.yandex.ru/metrika/tag.js`; story → `subscription_history`. Исходная ошибка primary допускается.
- Оба источника abort: 0 целей, pending в `localStorage`, reload без ложного sent.
- Поздний webhook: до confirmation целей нет; после ухода на gallery и возврата на coins цель уходит.
- Чужой/pending invoice, 5xx, logout: целей нет.

Unit `npm run verify:metrika` (91 check): очередь `ym` ≠ ready; новый script на fallback; late subscriber; remount без второго script; независимый retry второй цели; 401/5xx; generation после logout; storage quota сохраняет query/hash/`utm`; `invoiceId=ok` отвергнут; баннер 203→204; изоляция аккаунтов; частичный QuotaExceeded без повторной цели; полный отказ localStorage при живом sessionStorage; retry cap при stale dispatched; stale poll не пишет в чужой аккаунт; баннер в sessionStorage, не в новой вкладке; две вкладки без Web Locks; poll после 24 с и offline→online; `visiblePaymentStatus`.

Кабинет Яндекса **не проверялся**. Callback — сигнал клиентской отправки по API, не появление конверсии в отчёте.

## Команды и результаты

| Команда | Результат |
| --- | --- |
| `npm run verify:metrika` | 91 passed, exit 0 |
| `npm run verify:metrika:db` | PASS, engine=pglite; исторический PaymentEvent с NULL planId/amountRub |
| `npm run verify:metrika:browser` | 18 passed, exit 0; локальный Next на 4027, перехват аналитики до навигации |
| `node docs/metrika-independent-review-probe.cjs` | exit 1 — первый ревью-probe ждёт старые дефекты |
| `node docs/metrika-second-review-probe.cjs` | exit 1, `fetches 1 !== 0` — остаточный P1 полного отказа localStorage больше не воспроизводится |
| `npm run verify:p0-security` | 109 passed, exit 0 |
| `npm run verify:p0-p1` | 40 passed, exit 0 |
| `docs/p0-security-independent-repro.mjs` | leaked=false; scanner live-key exit 1 как задумано |
| `docs/p0-security-second-independent-repro.mjs` | leaked=false |
| `node docs/p0-security-logger-cycle-probe.cjs` | оба случая `completed=true`, `exit=0`, `timedOut=false` |
| `node docs/p0-security-staged-scan-probe.cjs` | staged live-key exit 1; staged deletion exit 0 |
| `npx tsc --noEmit` | exit 0 |
| eslint изменённых файлов этой задачи `--max-warnings 0` | exit 0 (`SubscriptionPlans` fetchBalance — прежний lint, не трогался) |
| `git diff --check` | exit 0 |
| `npm run build` (синтетические NEXTAUTH_SECRET / DATABASE_URL / DIRECT_URL, БД `127.0.0.1:1`) | exit 0; Prisma init в sitemap/DDL: `{category,name}` |

Существующие independent harness не ослаблялись; публичный контракт `formatErrorLog`/`errorLog` сохранён. Интерфейс logger не требовал нового runner.

## Честные ограничения

- Доступность `mc.yandex.*` у посетителя код гарантировать не может.
- Нет exactly-once во внешней аналитике при потере callback.
- Запрещённый storage: in-memory + сохранённый query; после полного reload без query событие теряется.
- Без Web Locks fallback-lease обновляется, пока вкладка владеет им; одновременный acquire двух вкладок не является CAS. Если localStorage.setItem недоступен, обработка идёт с in-tab lock и sessionStorage/памятью — без межвкладочного exactly-once.
- `Transaction.amount` не используется как рубли (там VC/0). Сумма только из verified OutSum.
- Передача дохода в кабинете не проверялась.
- P0 production-ротация по-прежнему pending у оператора.
- Playwright Chromium ставится отдельно (`npx playwright install chromium`); тесты не ходят на production URL из `.env`.
