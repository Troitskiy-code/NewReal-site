# Схема массового перевода промптов в production — 12 октября 2026

Схема применена. Код не выкладывался, `RP_PROMPT_V2_ENABLED` не включался, карточки и истории этой миграцией не переводились.

Время ниже — московское. Метки базы — UTC; к ним прибавлено 3 часа.

## База

Adminer, кластер Diligent Finch, база `default_db`, схема `public`. На месте `Character`, `Message` и `ChatPromptState`. Это та же production-база NewVerse.

Таблицы `_prisma_migrations` нет ни до, ни после. История Prisma не создавалась. `migrate deploy`, `db push` и старые миграции не запускались.

## Состояние до SQL

Только чтение, 20:30:38.

Новых объектов не было: `promptMigrationId`, `PromptMigrationEntry`, `PromptMigrationStory`, `PromptRollout` и пять новых индексов отсутствовали. Частичного применения не было.

| Показатель | Значение |
| --- | --- |
| Карточки | 237 |
| Пустой `systemPrompt` | 14 |
| Пустой `legacyPromptArchive` | 237 |
| Сообщения | 19435 |
| `ChatPromptState` | 105 |
| Отпечаток | `ee6eb1d01c1d1dfc03459257302de805` |

Отпечаток — MD5 строк `id`, MD5 `systemPrompt` и MD5 `legacyPromptArchive`, с меткой `NULL` вместо пустого текста, в порядке `id`. Тексты не выгружались.

Версии карточек до SQL:

| version | origin | mode | style | строк |
| --- | --- | --- | --- | --- |
| 1 | unknown | character | mixed | 218 |
| 1 | unknown | world | mixed | 11 |
| 2 | unknown | character | mixed | 6 |
| 2 | unknown | world | mixed | 2 |

Состояния историй: 101 × version 1 / character, 4 × version 2 / character. Эти восемь карточек и четыре состояния v2 уже были в базе. Миграция их не создавала и не меняла.

## Бэкап

Физический ручной бэкап непосредственно перед SQL: 12 октября 2026, 20:36, идентификатор Timeweb `106542823`, статус `done`. После обновления списка он первый из двенадцати копий, без строки подготовки. Предыдущий ручной бэкап — 11 октября, 23:09, `106472877`. Восстановление и скачивание не запускались.

## Транзакция

Один запрос Adminer: `BEGIN`, `lock_timeout` 5 с, `statement_timeout` 60 с, точный файл `prisma/migrations/20261012193000_prompt_bulk_rollout/migration.sql`, `COMMIT`. Остановка на ошибке была включена.

Старт: 20:36:56. Все `ALTER`, `CREATE` и `INSERT` прошли. `INSERT` в `PromptRollout` затронул 1 строку. `COMMIT` выполнен, 20:36:56–20:37. Таймауты не повышались.

## Проверка после COMMIT

Только чтение, 20:37:14, затем `ROLLBACK`.

`ChatPromptState.promptMigrationId`: text, NULL разрешён, значения по умолчанию нет.

Индексы действительны:

| Индекс | Уникальный | Определение |
| --- | --- | --- |
| `ChatPromptState_characterId_builderVersion_idx` | нет | btree (`characterId`, `builderVersion`) |
| `PromptMigrationEntry_characterId_status_idx` | нет | btree (`characterId`, `status`) |
| `PromptMigrationEntry_status_reviewedAt_idx` | нет | btree (`status`, `reviewedAt`) |
| `PromptMigrationEntry_active_card_idx` | да | btree (`characterId`) WHERE `status = 'applied'` |
| `PromptMigrationStory_entryId_scopeKey_key` | да | btree (`entryId`, `scopeKey`) |

Внешние ключи: `PromptMigrationEntry.characterId` → `Character.id` и `PromptMigrationStory.entryId` → `PromptMigrationEntry.id`, оба `ON UPDATE CASCADE` и `ON DELETE CASCADE`.

`PromptRollout`: одна строка `id = rp-v2`, `finalized = false`, `finalizedAt` пуст. `PromptMigrationEntry` и `PromptMigrationStory` пустые. Ничего не очищалось.

Контрольные показатели после SQL:

| Показатель | До | После |
| --- | --- | --- |
| Карточки | 237 | 237 |
| Пустой `systemPrompt` | 14 | 14 |
| Пустой архив | 237 | 237 |
| Сообщения | 19435 | 19435 |
| `ChatPromptState` | 105 | 105 |
| Отпечаток | `ee6eb1d01c1d1dfc03459257302de805` | тот же |
| Распределение версий карточек | 218 / 11 / 6 / 2 | то же |
| Распределение историй | 101 × v1, 4 × v2 | то же |

Число сообщений между срезами не изменилось. Схема тексты и версии не трогала.

## Готовность

База готова к выкладке кода, который читает `promptMigrationId`, при выключенном `RP_PROMPT_V2_ENABLED`. Сам деплой и включение флага в эту задачу не входили. Уже существующие 8 карточек и 4 состояния v2 остаются как были; массовый перевод их не выполнял.
