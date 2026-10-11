# Миграция эмбеддингов DeepInfra в production — 11 октября 2026

Схема применена. Код эмбеддингов не выкладывался, `EMBEDDING_AI_PROVIDER` не включался, пересчёт переписки не запускался.

Время ниже — московское. Часы базы в UTC; к ним прибавлено 3 часа.

## База и бэкап

Adminer, кластер Diligent Finch, база `default_db`, схема `public`. На месте `Message` и `MessageEmbedding`.

Физический ручной бэкап непосредственно перед SQL: 11 октября 2026, 23:09 МСК, идентификатор Timeweb `106472877`. После обновления страницы он первый в списке из одиннадцати копий, без строки прогресса. Восстановление не запускалось.

## Проверка до SQL

23:10:48 МСК, транзакция только для чтения.

- Расширение `vector` версии **0.8.3**.
- Метод доступа `hnsw` доступен.
- `MessageEmbedding.embedding` имеет тип `vector(1536)`.
- Таблиц `MessageEmbeddingDeepinfra` и `EmbeddingBackfillLease` не было.
- Сообщений 19195, старых эмбеддингов 18458. Тексты не читались.

## Транзакция

Один запрос Adminer: `BEGIN`, точный файл `prisma/migrations/20261011230000_deepinfra_embeddings/migration.sql`, `COMMIT`. В файле заданы `lock_timeout` 5 с и `statement_timeout` 60 с; таймауты не увеличивались. Создание обеих таблиц, уникального индекса и HNSW-индекса прошло без ошибки. `COMMIT` выполнен. `prisma migrate deploy`, `db push`, старые миграции и `_prisma_migrations` не запускались.

## Проверка после COMMIT

Независимая транзакция только для чтения, 23:11:26 МСК, затем `ROLLBACK`.

`MessageEmbeddingDeepinfra`:

| Колонка | Тип | NULL | По умолчанию |
| --- | --- | --- | --- |
| id | text | нет | нет |
| messageId | text | нет | нет |
| embedding | vector(1024) | нет | нет |
| createdAt | timestamp(3) | нет | CURRENT_TIMESTAMP |

Первичный ключ `MessageEmbeddingDeepinfra_pkey` по `id`. Уникальный индекс `MessageEmbeddingDeepinfra_messageId_key` по `messageId`, валиден. HNSW-индекс `MessageEmbeddingDeepinfra_embedding_hnsw_idx` по `embedding vector_cosine_ops` валиден и готов. Внешний ключ `MessageEmbeddingDeepinfra_messageId_fkey` на `Message(id)` с `ON UPDATE CASCADE` и `ON DELETE CASCADE`.

`EmbeddingBackfillLease`: `id` text NOT NULL, `owner` text NOT NULL, `leaseUntil` timestamp(3) NOT NULL. Первичный ключ `EmbeddingBackfillLease_pkey` по `id`.

Старый тип `MessageEmbedding.embedding` остался `vector(1536)`. В новых таблицах 0 строк. Сообщений по-прежнему 19195, старых эмбеддингов 18458.

Схема готова к выкладке кода. Пока код не выложен, новые таблицы пустые.
