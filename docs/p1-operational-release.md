# Выпуск P1, 2 октября 2026

Изменения подготовлены в рабочей копии. Production, реальные платежи, реальные
письма, production-счётчик Метрики, commit и push агентом не выполнялись.
P0-ротация NEXTAUTH_SECRET и пароля БД остаётся у оператора.

## Что входит

- Поддержка сохраняет clientKey и отпечаток отправленного черновика до POST.
  Потерянный ответ и reload не создают второй тикет; изменённый текст получает
  новый ключ. Тикет сохраняется до фоновой отправки через Next `after`.
- Outbox использует claim token, стабильный Resend idempotency key,
  максимум 6 попыток и окно 23 часа. Ожидание ответа SDK ограничено 10 секундами;
  это не отменяет уже принятую провайдером доставку. Cron обрабатывает 2 письма
  за запуск, чтобы укладываться в maxDuration=30.
- Недоставленные и исторические заявки показываются как dead/manual_review;
  cron возвращает 503 и reviewTicketIds для внешнего мониторинга. Тикеты сохраняются.
- Лимиты гостевого чата, переноса и поддержки атомарно хранятся в PostgreSQL.
  Ключи хешируются; expired buckets удаляет cleanup-anonymous.
- ResultURL проверяется строго по MD5 с Password#2, точным OutSum и всеми Shp_*.
  Password#1/#3, CRC32, фиксированная сумма и подпись без пользовательских полей
  больше не принимаются. Новый checkout продолжает использовать Password#1.
- PaymentEvent, VC/подписка, журнал и уведомление фиксируются одной транзакцией.
  Общая блокировка строки пользователя защищает одновременные покупки и активацию
  отложенного тарифа от потери купленных VC.
- Runtime DDL удалён из src; schema guards проверяют наличие колонок чтением.
  Проверки вне транзакции убраны из Prisma middleware, чтобы транзакция работала
  и с connection_limit=1.
- Успешный Google JWT получает отдельный eventId; login отправляется после
  готовности счётчика и не повторяется при reload. Credentials очищает этот eventId.
- На тарифах и в чате объяснены замена/сгорание VC подписки, постоянные купленные
  VC, порядок расхода и отдельная стоимость нового ответа/повтора/продолжения.
  Живые цены и размеры пакетов не менялись.

## Миграции: порядок оператора

1. Сделать резервную копию и проверить восстановление на отдельной БД.
   На копии проверить типы, индексы, связи и историю миграций, а не только колонки.
2. Для команд Prisma явно задать DATABASE_URL отдельной миграционной роли.
   Для `npm run db:preflight` задать MIGRATION_DATABASE_URL той же целевой БД.
   Скрипт preflight не читает .env, ничего не изменяет, проверяет базовые колонки,
   orphan counts и незавершённые миграции. Это не замена сравнению полной схемы.
3. Существующая БД: после проверки копии и только если baseline ещё отсутствует
   в истории выполнить `npx prisma migrate resolve --applied 20260801000000_baseline`.
   **SQL baseline на существующей БД не выполнять**; остальные миграции массово
   applied не помечать. Сохранять уже применённую историю и её checksums.
4. Чистая БД: baseline применяется обычным `migrate deploy`. Требуется доступный
   pgvector (`CREATE EXTENSION vector`) и право миграционной роли на его установку.
5. Перед production-upgrade остановить старые процессы приложения и дождаться
   завершения их записей/генераций. На период обслуживания ResultURL должен
   возвращать 503 для повторной доставки провайдером, а не ложное OK.
   Не оставлять старый webhook пишущим Transaction одновременно с backfill.
   Legacy pending становится failed с
   сохранённой резервацией; повтор не тратит гостевую квоту второй раз.
6. Выполнить `npx prisma migrate deploy`, затем `npm run db:preflight -- --ready`
   и `npx prisma migrate status`. Применить все pending миграции до выкладки кода,
   в том числе 20261001120000, 20261001180000, 20261001210000 и
   20261002120000_p1_operational_closure. Не менять SQL уже применённых миграций.
7. Новая FK при orphan rows останавливает миграцию; исправление данных требует
   проверки оператором, данные автоматически не удаляются.
8. Выкладывать приложение с DB-ролью SELECT/INSERT/UPDATE/DELETE без CREATE/ALTER.

## Внешняя настройка оператора

- Настроить SUPPORT_INBOX_EMAIL, RESEND_API_KEY, RESEND_FROM_EMAIL с проверенным
  доменом отправителя и CRON_SECRET. Секреты не передавать в чат/коммит.
- TRUST_PROXY=1 допустим только за прокси, который перезаписывает клиентские
  X-Forwarded-For/X-Real-IP. Без него используется общий unknown bucket.
- Планировщик: GET или POST `/api/cron/deliver-support` каждую минуту,
  `/api/cron/cleanup-anonymous` каждый час. Заголовок Authorization: Bearer
  CRON_SECRET. Секрет не помещать в URL. Мониторить 401/5xx и requiresAttention.
- После ручной проверки/обработки dead/manual_review оператор может отметить
  конкретную заявку `deliveryStatus='operator_handled'`; не переводить старые
  заявки массово обратно в pending после истечения окна idempotency.
- В кабинете Robokassa проверить MD5, Password#2, ResultURL и возврат всех Shp_*.
  Реальную совместимость настроек магазина подтверждает отдельная тестовая среда.
- В кабинете Метрики проверить события login, login_attempt, vc_purchase_success,
  subscription_success, subscription_dialog, subscription_history,
  subscription_universe. Реальный Google redirect и доставку в Яндекс/Resend
  проверить оператору после настройки; автоматические проверки провайдеры не вызывали.

## Сетевая диагностика Метрики

`npm run diagnose:metrika` получает tag.js отдельно от приложения и без
инициализации счётчика/целей. На этой машине оба адреса дают ECONNRESET в Node
и net::ERR_CONNECTION_CLOSED в чистом Edge. Контрольные example.com/yandex.ru
возвращают 200. Исходный результат: metrika-network-diagnostic-2026-10-02.json.

Это обрыв соединения с доменами Метрики до отправки покупки. Конкретный
фильтр/маршрут/прокси/узел по этому тесту не определяется. Проверить другую сеть,
например мобильную точку доступа; затем точечные правила для mc.yandex.com и
mc.yandex.ru. Переключение .com → .ru поддерживается Яндексом:
https://yandex.ru/support/metrica/ru/general/alternative-domain.

Fallback уже создаёт отдельный script. Если недоступны оба домена, успешную
отправку приложение не обещает; событие остаётся для восстановления. Отсутствие
красной строки F12 не считается доказательством исправности целей.

## Проверки и пределы

Итог запуска: `verify:p1:closure` — 100 passed (79 DB/handler/migration + 21 browser),
`verify:metrika:browser` — 18 passed, `verify:metrika` — 91 passed,
`verify:p0-security` — 109 passed, `verify:p0-p1` — 40 passed.
TypeScript, `git diff --check` и `node scripts/build-synthetic.mjs` — exit 0.
В изменённых/новых файлах ESLint errors нет. Полный ESLint: 25 errors / 23 warnings;
все ошибки относятся к файлам, не изменённым этим заданием. Сборка сохраняет
предупреждение Turbopack tracing в прежнем currencyRates/next.config пути.

`verify:p1:closure`: отдельный native PostgreSQL 18, полный fresh migrate deploy,
populated legacy schema + migrate resolve/deploy, реальные подписанные NextRequest
handlers, rollback с настоящим DB trigger, параллельные лимиты/claims/начисления,
и браузер guest → login → transfer → support lost-response → webhook → goal → logout.
Браузерный сервер использует no-DDL роль с connection_limit=1. Google JWT callback
проверяется реально, внешний OAuth redirect заменён session fixture.

В native PG fixture только pgvector/RAG заменён BYTEA: исходный SQL остальных
миграций не меняется. Это не проверка RAG или установка pgvector в production.
Тестовая почта не доставляется наружу, счётчик используется 999001/перехват,
production DATABASE_URL из .env не используется.

Запуск: установить embedded-postgres в отдельный временный каталог, указать
GUEST_TEST_RUNTIME. Для браузера дополнительно GUEST_TEST_BROWSER=1 и при
отсутствии bundled Chromium GUEST_TEST_BROWSER_CHANNEL=msedge.
`verify:p1:closure` без browser flag проверяет только DB/handlers.

P2, экономика и общий ESLint-долг остаются отдельными задачами.
