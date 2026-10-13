# Значения по умолчанию prompt v2 в production — 13 октября 2026

Миграция `prisma/migrations/20261012220000_prompt_v2_defaults/migration.sql` применена к production. Данные не менялись.

## Проверка до SQL

Adminer, база `default_db`, схема `public`. Запрос только на чтение к `information_schema.columns` и подсчёт строк:

| Колонка | Значение по умолчанию | Строк | Строк не на версии 2 |
| --- | --- | --- | --- |
| `Character.promptBuilderVersion` | 1 | 239 | 0 |
| `ChatPromptState.builderVersion` | 1 | 195 | 0 |

Миграция не была применена, а все существующие карточки и состояния чатов уже на версии 2. Значит, SQL меняет только значение по умолчанию для будущих вставок.

## Транзакция

Один запрос Adminer с включённым «Остановить при ошибке»:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "Character" ALTER COLUMN "promptBuilderVersion" SET DEFAULT 2;
ALTER TABLE "ChatPromptState" ALTER COLUMN "builderVersion" SET DEFAULT 2;
COMMIT;
```

Все шесть команд завершились без ошибок, каждая — около 0,01–0,02 с, «изменено 0 записей». `_prisma_migrations`, другие миграции, seed и `db push` не запускались.

Бэкап перед SQL не создавался: команды меняют только метаданные колонок, не затрагивают строки и откатываются так же мгновенно (см. ниже).

## Проверка после COMMIT

Тот же запрос на чтение: значение по умолчанию у обеих колонок `2`, строк по-прежнему 239 и 195, строк не на версии 2 — 0.

## Откат

Если понадобится вернуть прежние значения по умолчанию:

```sql
ALTER TABLE "Character" ALTER COLUMN "promptBuilderVersion" SET DEFAULT 1;
ALTER TABLE "ChatPromptState" ALTER COLUMN "builderVersion" SET DEFAULT 1;
```

## Что осталось

Удалить из переменных Relaxdev `RP_PROMPT_V2_ENABLED` и, если есть, `CHARACTER_PROMPT_MODEL`: после выкладки 2d7cb72 они ни на что не влияют.
