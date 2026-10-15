# «Первый шаг»: стиль персонажа в production — 15 октября 2026

Миграция `prisma/migrations/20261015120000_character_art_style/migration.sql` применена к production до выкладки кода, который читает `Character.artStyle`.

## Проверка до SQL

Adminer, база `default_db`, схема `public`, только чтение. Колонки `artStyle` не было. Публичных карточек со slug 121, из них с аватаром 118 (117 аватаров хранятся как `data:` URL). Тег «Аниме» у 47, предупреждений модерации 0.

## Схема

```sql
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "artStyle" TEXT;
COMMENT ON COLUMN "Character"."artStyle" IS 'Migration 20261015120000_character_art_style; sha256 5bfd5abc90c0c77f2dcd8909824dd7f25e1487f84c86cd55cb6870379a09a221; applied through Adminer to existing manually managed schema';
```

Обе команды завершились без ошибок за 0,01–0,02 с, «изменено 0 записей». Колонка необязательная, значения по умолчанию нет, существующие строки не переписывались. `_prisma_migrations`, другие миграции и `db push` не запускались.

## Разметка по тегам и описанию аватара

Публичные карточки с аватаром и пустым `artStyle`. Правило: тег «Аниме» или упоминание anime/manga без слов о фотографии дают `anime`. Слова photo/photorealistic/realistic/cinematic/реалист/фото без признаков аниме и без слов «иллюстрация / art / рисунок / painting» дают `realistic`. Противоречивые и молчащие карточки остаются пустыми. Перед записью вручную проверена случайная выборка из 12 кандидатов в `realistic`: 9 описаны как Photorealistic, 1 — портрет без явного стиля, 2 — иллюстрации. Иллюстрации исключены дополнительным условием.

`UPDATE ... WHERE "artStyle" IS NULL` изменил 82 записи. `updatedAt` не менялся, поэтому URL аватаров и кэш остались прежними.

| artStyle | Карточек |
| --- | --- |
| anime | 50 |
| realistic | 32 |
| пусто | 36 |

Пустые карточки участвуют в подборе с меньшим весом. Их можно доразметить по изображению: `POST /api/admin/character-art-style` с `{"mode":"vision"}` (сначала без записи), затем с `"dryRun": false`; нужен заголовок `x-admin-secret`.

## Откат

```sql
ALTER TABLE "Character" DROP COLUMN IF EXISTS "artStyle";
```

Только после отката кода: Prisma Client с полем `artStyle` выбирает его в запросах без `select`.
