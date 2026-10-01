# Фактическое состояние: аватары и навигация `/chat`, `/pricing`

Дата съёма: 30 сентября 2026. Код не менялся. Источник — репозиторий. Запрос агрегатов к `DATABASE_URL` из этой среды завершился `EACCES`; цифры прод-БД и логи RelaxDev / Better Stack здесь не сняты.

---

## Блок A. Аватары

### A1. Где физически хранится аватар персонажа

**Поле в `Character`:** `imageUrl String?` (Prisma; для PostgreSQL это текстовая колонка, не `Bytes`, без `@db.Text`). Рядом то же самое для референса генерации: `imageLora String?`.

```29:61:prisma/schema.prisma
model Character {
  id                String   @id @default(cuid())
  name              String
  slug              String?  @unique
  // ...
  imageUrl          String?
  // ...
  imageLora         String?   // Аватар для улучшенной генерации
```

Отдельной таблицы «Avatar» нет. Значение — строка в Postgres: на пути CreateYa это **data URL целиком** (`data:<mime>;base64,...`). Роут отдачи также умеет `http://` / `https://` / путь, начинающийся с `/`.

Связанные, но не «аватар карточки персонажа»:

| Модель | Поле | Тип | Назначение |
| --- | --- | --- | --- |
| `Persona` | `avatarUrl` | `String? @db.Text` | аватар персоны в чате |
| `User` | `image` | `String?` | картинка аккаунта (OAuth) |
| `Creation` | `imageUrl` / `resultImage` | `String?` | модели шаблона MuAPI, не CreateYa-персонаж |

**Файлы на диске / `public/`:** каталога аватаров персонажей нет. В `public/` лежат статика сайта (`logo.png`, иконки, `locales/`). Имя файла аватара персонажа в `public/` не формируется.

`User` хранит только счётчики генераций, не бинарник картинки:

```283:286:prisma/schema.prisma
  avatarTokens       Int           @default(10)
  lastTokenReplenish DateTime      @default(now())
  tokensUsedThisMonth Int          @default(0)
  lastTokenMonth     DateTime      @default(now())
```

### A2. Как аватар попадает в БД

`POST /api/generate-avatar` **не пишет в `Character`**. Он генерирует картинку, списывает месячную квоту и возвращает JSON `{ imageUrl }`. В БД строка попадает позже, когда клиент создаёт или обновляет персонажа.

Цепочка CreateYa:

1. `src/components/CharacterForm.tsx` — `POST /api/generate-avatar` с полями имени, промпта, `referenceImage`, `style`, `modelId`.
2. `src/app/api/generate-avatar/route.ts` — CreateYa + перевод URL в data URL.
3. Клиент держит data URL в стейте (`onAvatarGenerated` / `generatedAvatarUrl`).
4. `POST /api/characters` или `PUT /api/characters/[id]` записывает `imageUrl` в `Character`.

Генерация (без записи в Character):

```84:88:src/app/api/generate-avatar/route.ts
    const createdUrl = await generateWithCreateya(prompt, referenceImage || undefined, apiModel);
    const imageUrl = await imageUrlToDataUrl(createdUrl);
    await recordMonthlyGeneration(user);

    return NextResponse.json({ imageUrl });
```

CreateYa сначала отдаёт **HTTP(S) URL** файла (`extractOutputUrl`: `output.url` / `output.urls[]` / `url`). Затем сервер скачивает байты и упаковывает в data URL:

```466:474:src/lib/createya.ts
export async function imageUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith("data:")) return imageUrl;
  const response = await axios.get<ArrayBuffer>(imageUrl, {
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  const mime = String(response.headers["content-type"] || "image/webp").split(";")[0];
  const base64 = Buffer.from(response.data).toString("base64");
  return `data:${mime};base64,${base64}`;
}
```

**Вид в БД на этом пути:** полный data URL (`data:<mime>;base64,<payload>`), не ссылка CreateYa и не путь к файлу.

Запись в БД при создании:

```69:78:src/app/api/characters/route.ts
    let character = await prisma.character.create({
      data: {
        // ...
        imageUrl: imageUrl ?? null,
        imageLora: imageLora ?? null,
```

Клиент `/create` передаёт либо `generatedAvatarUrl` (результат generate-avatar), либо результат `POST /api/upload` (тоже data URL). Лимит загрузки файла: **5 МБ**, затем base64 data URL:

```12:22:src/app/api/upload/route.js
    // Проверка размера (максимум 5 МБ)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Максимальный размер файла — 5 МБ" }, { status: 400 });
    }
    // ...
    const url = `data:${mimeType};base64,${base64}`;
```

`parseCharacterBody` принимает `imageUrl` как строку без отдельного лимита длины (`src/lib/characterFields.ts`).

Модель CreateYa выбирается в `src/lib/avatarModels.ts` (`resolveCreateyaAvatarModel`). `costMultiplier` в generate-avatar только логируется, на запись в БД не влияет.

Референс перед CreateYa: `convertImageToPNG` (Jimp) — только входной референс, не выход генерации.

### A3. Как аватар отдаётся клиенту

**Карточки каталога, избранное, «мои персонажи», список чатов, публичная карточка:** не сырой data URL, а API-путь.

```7:14:src/lib/characterCardImage.ts
export function characterAvatarPath(
  characterId: string,
  updatedAt?: Date | string | number | null
): string {
  const version = avatarVersion(updatedAt);
  const path = `/api/characters/${characterId}/avatar`;
  return version ? `${path}?v=${version}` : path;
}
```

Клиент: обычный **`<img src={...}>`**, не `next/image`. Примеры: `CharacterCard.tsx` (строки 49–51), `chats/page.tsx` (150–157), `CharacterPublicView.tsx`.

Роут: `GET /api/characters/[id]/avatar` (`src/app/api/characters/[id]/avatar/route.ts`).

Поведение:

- нет `imageUrl` → 404;
- приватный персонаж и чужая сессия → 404;
- значение начинается с `http://`, `https://` или `/` → **редирект** на этот URL;
- значение `data:` → разбор MIME/base64, тело ответа — сырые байты картинки (`Content-Type` jpeg/png/webp/gif/avif).

**Чат `/chat/[id]`:** `GET /api/chat/[id]` возвращает `character.imageUrl` **как лежит в БД** (для CreateYa — data URL). Клиент:

- фон: `ChatPortraitBackground` — CSS `background-image: url(${imageUrl})`;
- аватар сообщения: `<img src={imageUrl}>`.

```468:469:src/app/api/chat/[id]/route.ts
        greeting: character.greeting,
        imageUrl: character.imageUrl,
```

Список `/chats` подменяет поле на путь API:

```127:128:src/app/api/chats/route.ts
            updatedAt: character.updatedAt,
            imageUrl: characterAvatarPath(character.id, character.updatedAt),
```

**Cache-Control**

На роуте отдачи (логика handler):

- публичный персонаж: `public, max-age=31536000, immutable` (`YEAR_CACHE`); то же в `CDN-Cache-Control` для байтового ответа;
- приватный: `private, no-store`.

```11:11:src/app/api/characters/[id]/avatar/route.ts
const YEAR_CACHE = "public, max-age=31536000, immutable";
```

```55:74:src/app/api/characters/[id]/avatar/route.ts
    const cacheControl = character.isPublic ? YEAR_CACHE : "private, no-store";
    // ...
        "Cache-Control": cacheControl,
        "CDN-Cache-Control": cacheControl,
```

Дополнительно `next.config.mjs` вешает на `/api/characters/:id/avatar` всегда `public, max-age=31536000, immutable` (слой headers Next). Query `?v=<updatedAt ms>` используется как cache-buster в URL карточек.

`next/image` для аватара персонажа не используется (в `Header.jsx` — только `/logo.png`).

### A4. Масштаб

Из этой среды запрос к Postgres (`pg_column_size("imageUrl")`, доли `data:` / `http`, среднее число аватаров на пользователя с `lastSeen` за 30 дней) **не выполнен**: ошибка соединения `EACCES`. Логи RelaxDev / Better Stack / Метрика по числу аватаров не читались.

Способ оценки, который есть в схеме: SQL по `"Character"."imageUrl"` и `"User"."lastSeen"`. Результата прогона нет.

### A5. Лимиты и квоты

Месячный лимит генераций CreateYa проверяется в `canGenerateThisMonth` / `recordMonthlyGeneration`. Счётчик: `User.tokensUsedThisMonth`, сброс по календарному месяцу `lastTokenMonth`.

```8:13:src/lib/avatarTokens.ts
export const MONTHLY_LIMITS = {
  free: 0,
  dialog: 20,
  history: 50,
  universe: 150,
} as const;
```

Без активной подписки лимит **0**. `history` и `story` оба дают 50. Проверка в generate-avatar: при исчерпании — HTTP 402, текст «Достигнут месячный лимит бесплатных генераций». После успешной генерации `tokensUsedThisMonth + 1`.

Второй контур: `User.avatarTokens` (потолок `MAX_AVATAR_TOKENS = 10`), пополнение раз в `AVATAR_REPLENISH_HOURS = 6` через `replenishAvatarTokens`. Вызов есть в `GET /api/user/balance`. **`POST /api/generate-avatar` этот баланс не проверяет и не уменьшает** — только месячный `tokensUsedThisMonth`.

`GET /api/avatar-tokens` возвращает `{ tokensUsedThisMonth, monthlyLimit, monthlyRemaining }` (`getAvatarTokenStatus`).

Лимита размера `Character.imageUrl` в схеме и в `parseCharacterBody` нет. Лимит 5 МБ — только у `POST /api/upload`. Лимита «N аватаров на пользователя» в коде генерации нет (есть N генераций в месяц и одно поле `imageUrl` на персонажа).

### A6. Сжатие / оптимизация выхода CreateYa

В `package.json` нет `sharp` и squoosh. Jimp используется в `convertImageToPNG` для **референса** (приведение к PNG data URL перед CreateYa).

Выход генерации: скачивание байтов CreateYa и base64 **без** ресайза, без смены формата, без quality. MIME берётся из `Content-Type` ответа (fallback `image/webp`). Итог: «как есть» от провайдера, упакованное в data URL.

---

## Блок B. Навигация `/chat` и `/pricing`

### B1. Корневой layout и `force-dynamic`

Корневой файл — **`src/app/layout.js`**, не `layout.tsx`.

```16:16:src/app/layout.js
export const dynamic = "force-dynamic";
```

Тот же layout: `generateMetadata` → `await getLocalizedPageMetadata("home")`; тело → `await getRequestLocale()` (cookies/headers, без БД). Дети обёрнуты в клиентский `AppShell`.

Другой `dynamic = "force-dynamic"`: `src/app/character/[slug]/page.tsx`, `src/app/api/currency/rates/route.ts`. У `src/app/pricing/page.js` и `src/app/chat/[id]/page.tsx` своей директивы нет (обе страницы `"use client"`). На них действует корневой `force-dynamic`.

**`loading.tsx`:** файлов `loading.tsx` / `loading.js` в `src/app/`, `src/app/chat/`, `src/app/chat/[id]/`, `src/app/pricing/`, `src/app/chats/` **нет** (поиск по репозиторию: 0 файлов `loading.tsx`).

Есть layout-ы: `src/app/pricing/layout.tsx`, `src/app/chat/[id]/layout.tsx`. У `src/app/chats/` layout нет.

### B2. Хедер / меню

| Слой | Файл | Роль |
| --- | --- | --- |
| Оболочка | `src/components/AppShell.jsx` | `Header` + `Navbar` + баннер почты |
| Шапка | `src/components/Header.jsx` | логотип (`LocaleLink` на `/`), язык, уведомления, меню пользователя |
| Боковое / мобильное меню | `src/components/Navbar.jsx` | пункты Home, Chats (`/chats`, match `/chat`), Pricing (`/pricing`, match `/subscription`), Coins, Create, Profile, Favorites, Support |

Пункты меню — **`LocaleLink`** → `next/link` с локализованным `href`. Пропа `prefetch` ни в `LocaleLink`, ни в `Navbar`/`Header` нет (поиск `prefetch=` по `src`: 0 совпадений). Отдельного prefetch on hover в коде нет. Поведение prefetch — дефолт App Router для `<Link>` (в viewport, без явного `prefetch={false}`).

`router.push` в шапке/сайдбаре навигации нет. `router.push` есть на других страницах (логин, create после сохранения, checkout без сессии). Обычные `<a href>` в навигации приложения для меню не используются (кроме писем Resend).

### B3. Страница `/pricing`

`src/app/pricing/page.js` — клиентский компонент. Серверных `await` в самой странице нет. Рендер: `SubscriptionPlans` + `Footer`.

`src/app/pricing/layout.tsx`:

```1:8:src/app/pricing/layout.tsx
import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("pricing");
}
```

`getLocalizedPageMetadata` делает `await getRequestLocale()` (cookie/header) и берёт строки из словаря. Тарифы, курсы и модели в metadata не грузятся.

Данные UI:

| Источник | Когда | Что |
| --- | --- | --- |
| `SUBSCRIPTION_PLANS` из `src/lib/chatEconomy.ts` | бандл клиента | цены 499 / 1299 / 3499 ₽ и т.д. |
| `GET /api/user/balance` | `useEffect`, только `status === "authenticated"` | тип/конец подписки, pending |
| `GET /api/currency/rates` | `CurrencyProvider` в корневых `Providers`, `fetch(..., { cache: "no-store" })` | USD/EUR |
| Модели чата | не загружаются | — |

Курсы на API: `dynamic = "force-dynamic"`, ответ `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. Серверный кэш ещё в `src/lib/currencyRates.ts` (память + `.currency-cache.json` / tmp, TTL 24 ч). Клиентский fetch с `cache: "no-store"` не использует HTTP-кэш браузера на этот запрос. Fallback UI: `FALLBACK_RATES` USD 90 / EUR 100, пока запрос не завершился.

`unstable_cache` в проекте не используется (совпадение только `revalidate = 3600` у `src/app/sitemap.ts`). На самой `/pricing` серверного кэша страницы нет: корневой `force-dynamic` + клиентский рендер.

### B4. `/chat/[id]` и `/chats`

**`/chat/[id]`**

Страница `src/app/chat/[id]/page.tsx` — `"use client"`. До гидрации RSC отдаёт layout.

Сервер до HTML layout: `generateMetadata` в `src/app/chat/[id]/layout.tsx` — `await prisma.character.findUnique({ select: { name: true } })` для title. Viewport: `interactiveWidget: "resizes-visual"`. Тело layout — `{children}` без данных чата.

После монтирования, пока `status === "loading"` или `loading === true`, UI — спиннер на весь экран чата (строки 1513–1520). Сообщения и шелл композера в этот момент не показываются.

Залогиненный пользователь параллельно:

- `GET /api/chat/[id]` — вся история `Message` (`orderBy createdAt asc`) + поля персонажа включая сырой `imageUrl`;
- `GET /api/models`;
- `GET /api/user/balance` (внутри ещё `replenishAvatarTokens`);
- `GET /api/chat/[id]/persona`.

Гость: только `GET /api/chat/[id]` (анонимный payload).

Спиннер снимается в `finally` после этих запросов. Отложенной подгрузки сообщений после шелла в коде нет: история нужна до первого рабочего рендера чата.

**`/chats`**

Только `src/app/chats/page.tsx` (`"use client"`), layout сегмента нет. После `useSession === "authenticated"` — `GET /api/chats` (groupBy сообщений, превью 150 символов, аватар через `characterAvatarPath`). Пока сессия или список грузятся — спиннер. Серверного fetch списка чатов до рендера страницы нет.

### B5. Замеры и жалобы на загрузку

Время ответа `/` и `/pricing` в прод-логах RelaxDev / Better Stack из этой среды **не снималось**. Поиск по `src` строк про «долгую загрузку» страниц не дал пользовательских жалоб; есть логи пула Prisma, таймауты Kodik/CreateYa/CBR, не TTFB `/pricing`.

`/` (`src/app/page.js`): сервер ждёт `getRequestLocale` и JSON-LD; каталог грузит клиент `HomePageContent` через `usePaginatedCharacters` (спиннер списка). Корневой `force-dynamic` сохраняется.
