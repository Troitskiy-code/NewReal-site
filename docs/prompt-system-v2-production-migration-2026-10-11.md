# Миграция RP-промптов v2 в production — 11 октября 2026

Схема применена. Код v2 не выкладывался, `RP_PROMPT_V2_ENABLED` не переключался, карточки и истории на v2 не переводились.

Время ниже — московское. Часы базы хранятся как UTC; к ним прибавлено 3 часа.

## База

Adminer, кластер Diligent Finch, база `default_db`, схема `public`. На месте таблицы `Character` и `Model`. Это та же production-база, к которой раньше применялся каталог моделей.

Таблицы `_prisma_migrations` нет ни до, ни после. История Prisma не создавалась.

## Бэкап

Свежая копия создана непосредственно перед SQL. Физический ручной бэкап: 11 октября 2026, 11:51, идентификатор Timeweb `106434609`. После обновления страницы он первый в списке из восьми копий, без строки прогресса. Предыдущий ручной бэкап — 10 октября, 21:22. Восстановление и скачивание не запускались.

## Схема до применения

Проверка только для чтения в 11:53:16.

Шести колонок `legacyPromptArchive`, `promptOrigin`, `promptBuilderVersion`, `roleplayMode`, `roleplayStyle`, `rpConfig` в `Character` не было. Таблицы `ChatPromptState`, её ключей и индекса не было. Частичного применения не обнаружено, поэтому SQL выполнен.

Карточек: 229. Из них `systemPrompt` пуст у 6. Контрольный отпечаток пар `id` и текста, с отдельной меткой NULL: `34c51ca7f1d92187c95d7797e781425c`. Сами тексты не выгружались.

## Транзакция

Один скрипт: `BEGIN`, `lock_timeout` 5 с, `statement_timeout` 60 с, точный SQL `prisma/migrations/20261011120000_roleplay_prompt_v2/migration.sql`, `COMMIT`.

Старт транзакции: 11:53:37. `ALTER TABLE`, `CREATE TABLE` и уникальный индекс прошли без ошибки. `COMMIT` выполнен. `seed`, `db push`, исторические миграции и запись в `_prisma_migrations` не запускались. `systemPrompt` этим SQL не обновлялся.

## Проверка после COMMIT

Независимая транзакция только для чтения, 11:53:51, затем `ROLLBACK`.

Колонки `Character`:

| Колонка | Тип | NULL | Значение по умолчанию |
| --- | --- | --- | --- |
| legacyPromptArchive | text | да | нет |
| promptOrigin | text | нет | `unknown` |
| promptBuilderVersion | integer | нет | 1 |
| roleplayMode | text | нет | `character` |
| roleplayStyle | text | нет | `mixed` |
| rpConfig | jsonb | да | нет |

`ChatPromptState`: `id`, `scopeKey`, `characterId` — text NOT NULL; `builderVersion` integer NOT NULL, по умолчанию 1; `mode` text NOT NULL, по умолчанию `character`; `createdAt` timestamp(3) NOT NULL, по умолчанию `CURRENT_TIMESTAMP`; `updatedAt` timestamp(3) NOT NULL, без значения по умолчанию.

Ограничения: первичный ключ `ChatPromptState_pkey` по `id`; внешний ключ `ChatPromptState_characterId_fkey` на `Character(id)` с `ON UPDATE CASCADE` и `ON DELETE CASCADE`. Уникальный индекс `ChatPromptState_scopeKey_characterId_key` по `("scopeKey", "characterId")`.

Карточек по-прежнему 229. Пустых `systemPrompt` по-прежнему 6. Отпечаток тот же: `34c51ca7f1d92187c95d7797e781425c`. У всех 229 строк version=1, origin=unknown, mode=character, style=mixed. `legacyPromptArchive` и `rpConfig` у всех 229 пустые. В `ChatPromptState` 0 строк.

## Что это значит

Схема готова к коду, который читает эти поля. Сам код v2 в этой задаче не выкладывался. Пока флаг выключен, новые колонки не меняют поведение старых промптов: тексты на месте, архив пуст, состояния историй не созданы.
