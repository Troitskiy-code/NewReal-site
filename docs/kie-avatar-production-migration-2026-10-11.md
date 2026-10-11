# Миграция AvatarGeneration в production — 11 октября 2026

Миграция применена и зафиксирована. Код Kie, cron и переменные окружения в этой задаче не менялись.

Время ниже — московское. Часы базы в UTC; к ним прибавлено 3 часа.

## База

Adminer, кластер Diligent Finch, база `default_db`, схема `public`. На месте `User`, `Character`, `AvatarQuotaReservation` и `AiCostEvent`. Таблицы `_prisma_migrations` нет ни до, ни после. История Prisma не создавалась.

`AvatarQuotaReservation` до SQL: `id` text NOT NULL, `userId` text NOT NULL, `units` integer NOT NULL, `month` timestamp NOT NULL, `status` text NOT NULL по умолчанию `reserved`, `createdAt` timestamp NOT NULL по умолчанию `CURRENT_TIMESTAMP`. После SQL набор колонок тот же.

Количества до применения, 18:55:41: пользователей 650, карточек 231, резервов квоты 0. После COMMIT, 18:56:13, те же 650, 231 и 0. В `AvatarGeneration` 0 строк.

## Бэкап

Физический ручной бэкап непосредственно перед SQL: 11 октября 2026, 18:54, идентификатор Timeweb `106458599`. После обновления страницы он первый в списке из девяти копий, без строки прогресса. Восстановление и скачивание не запускались.

## Транзакция

Один скрипт: `BEGIN`, `lock_timeout` 5 с, `statement_timeout` 60 с, точное содержимое `prisma/migrations/20261011190000_kie_avatar_jobs/migration.sql`, `COMMIT`.

До SQL таблицы `AvatarGeneration` не было. Старт транзакции 18:55:54. Создание таблицы и пять индексов прошли без ошибки. `COMMIT` выполнен. `prisma migrate deploy`, `db push`, остальные миграции и запись в `_prisma_migrations` не запускались. Карточки, пользователи, резервы и история затрат не изменялись. Тестовые строки и платные генерации не создавались.

## Проверка после COMMIT

Независимая транзакция только для чтения, 18:56:13, затем `ROLLBACK`.

Колонки `AvatarGeneration` совпадают с SQL: 19 полей. `state` text NOT NULL, по умолчанию `creating`. `creditRub` double precision NOT NULL, по умолчанию 0.5. `estimatedCredits` double precision NOT NULL, без значения по умолчанию. `credits`, `providerTaskId`, `imageUrl`, `errorCode`, `leaseToken` допускают NULL. `leaseUntil` timestamp(3) NULL. `nextPollAt` и `createdAt` — timestamp(3) NOT NULL, по умолчанию `CURRENT_TIMESTAMP`. `updatedAt` timestamp(3) NOT NULL, без значения по умолчанию.

Ограничения: первичный ключ `AvatarGeneration_pkey` по `id`. Внешний ключ `AvatarGeneration_reservationId_fkey` на `AvatarQuotaReservation(id)` с `ON UPDATE CASCADE` и `ON DELETE CASCADE`.

Индексы:

- уникальный `AvatarGeneration_reservationId_key` по `reservationId`;
- уникальный `AvatarGeneration_providerTaskId_key` по `providerTaskId`;
- уникальный `AvatarGeneration_userId_clientKey_key` по `userId`, `clientKey`;
- `AvatarGeneration_userId_scope_createdAt_idx` по `userId`, `scope`, `createdAt`;
- `AvatarGeneration_state_nextPollAt_idx` по `state`, `nextPollAt`.

Первичный ключ дополнительно представлен уникальным индексом по `id`.
