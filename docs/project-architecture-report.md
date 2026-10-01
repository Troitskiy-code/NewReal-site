# NewVerse: отчёт по проекту, дерево и внешняя архитектура

**Продукт:** NewVerse — платформа AI-персонажей и ролевого чата
**Прод:** [https://newvers.ai](https://newvers.ai)
**Репозиторий:** `ai-character-studio` (форк шаблона Common SaaS / MuAPI, рабочая экономика и чат переписаны)
**Стек:** Next.js 16 (App Router, Turbopack) · React 19 · Prisma 5 · PostgreSQL + pgvector · NextAuth 4 · Tailwind 4
**Хостинг приложения:** RelaxDev (Docker Next)
**Дата отчёта:** 30 сентября 2026
**Локали:** `ru` (по умолчанию), `en` — cookie `NEXT_LOCALE`, без сегмента `[lang]` в App Router

Соседний файл по юнит-экономике тарифа «Вселенная»: [`universe-subscription-economy-report.md`](./universe-subscription-economy-report.md).

---

## 1. Что это за проект

NewVerse — SaaS, в котором пользователь создаёт персонажа (карточка, память, аватар), общается с ним в чате и платит рублями за подписку и VerseCoins.

Ядро продукта:

| Контур | Что делает |
| --- | --- |
| Каталог и карточки | Публичные и свои персонажи, избранное, галерея, модерация |
| Чат | Стриминг ответов, модели с разной ценой в VC, гости до лимита сообщений |
| Память | Summary, Core, Episodic, RAG-эмбеддинги (флаг, по умолчанию выкл.) |
| Аватары | 150 генераций / мес на «Вселенной» через CreateYa |
| Биллинг | Подписки Диалог / История / Вселенная и пакеты VC через Robokassa |
| Аккаунт | Почта+пароль, опционально Google, верификация почты, рефералка |

Бойлерплейт README (Vercel, Stripe, MuAPI Nano Banana) **не описывает текущий прод**. Актуальные платежи — Robokassa, чат — KodikRouter, картинки персонажей — CreateYa, хост — RelaxDev.

---

## 2. Как устроен рантайм

```
Браузер ──► RelaxDev (Next.js) ──► PostgreSQL
                 │
                 ├── KodikRouter     чат, память, эмбеддинги, промпт персонажа
                 ├── CreateYa        генерация аватаров
                 ├── Robokassa       оплата и рекуррент
                 ├── Google Identity OAuth (если ключи заданы)
                 ├── Resend          письма
                 ├── Yandex Translate  EN-поля карточек
                 ├── ЦБ РФ           курсы валют
                 └── Better Stack    логи
Браузер ──► Yandex Metrika
cron-job.org ──► /api/cron/* на RelaxDev
```

Приложение `force-dynamic` в корневом layout: страницы не статически кэшируются целиком. Статика (`/_next/static`, картинки, аватар персонажа) отдаётся с длинным Cache-Control.

---

## 3. Дерево проекта

Дерево без `node_modules`, `.next`, `.git`. Это рабочая карта репозитория, не дамп каждого файла.

```
ai-character-studio/
├── AGENTS.md / CLAUDE.md     правила агента: Next.js 16, читать node_modules/next/dist/docs
├── README.md                 устаревший шаблон (Vercel / Stripe / MuAPI)
├── package.json
├── next.config.mjs           dotenv, cache headers, serverExternalPackages
├── tsconfig.json
├── .env.example              секреты прод-контура (без KODIKROUTER_API_KEY — см. §5)
│
├── docs/
│   ├── universe-subscription-economy-report.md
│   └── project-architecture-report.md          ← этот файл
│
├── prisma/
│   ├── schema.prisma         модели продукта + остатки шаблона (Creation, AppInstance)
│   ├── seed.js               каталог LLM и priceVC
│   ├── preinstall.cjs / prisma-env.cjs
│   ├── migrations/           SQL-миграции (2026-08 … 2026-09)
│   └── sql/                  pgvector, фикс модели Grok
│
├── public/
│   ├── locales/ru/common.json
│   ├── locales/en/common.json
│   ├── иконки, favicon, manifest, logo
│   └── verification-4dc35.txt
│
├── scripts/
│   ├── prisma-generate.cjs
│   ├── translate-characters.ts
│   ├── backfill-character-slugs.ts
│   ├── verify-economy.ts / verify-intent.ts / verify-payment-goals.ts
│   └── probe-*.cjs, verify-memory-*.cjs
│
└── src/
    ├── app/                  App Router: страницы + Route Handlers
    ├── components/           UI (чат, карточки, биллинг, i18n)
    ├── hooks/
    └── lib/                  домен: чат, память, оплата, персонажи
```

### 3.1. Страницы (`src/app`)

| Путь | Назначение |
| --- | --- |
| `/` | Каталог персонажей |
| `/create`, `/edit/[id]` | Создание и правка карточки |
| `/character/[slug]` | Публичная карточка |
| `/chat/[id]`, `/chats` | Чат и список диалогов |
| `/gallery`, `/favorites` | Галерея и избранное |
| `/login`, `/register`, `/forgot-password`, `/reset-password/[token]`, `/verify-email/[token]` | Аккаунт |
| `/pricing`, `/subscription`, `/coins`, `/balance`, `/realcoins`, `/tokens` | Тарифы и кошелёк |
| `/profile`, `/referral`, `/notifications` | Профиль, рефералка, уведомления |
| `/offer`, `/privacy`, `/terms`, `/rules`, `/refund`, `/support` | Юридические и поддержка |
| `/sitemap.ts`, `/robots.ts` | SEO |

Локаль **не** вложена в `src/app/[lang]`: язык из cookie/заголовка (`src/lib/i18nConfig.ts`).

### 3.2. API (`src/app/api`) — группы

```
api/
├── auth/                 NextAuth, register, verify-email, reset-password
├── chat/                 стрим чата, regenerate, память, персона
├── characters/           CRUD, slug, аватар, промпт, memory permissions
├── personas/             персоны пользователя в чате
├── generate-avatar/      CreateYa
├── payment/              Robokassa: create + webhook
├── subscription/         create, change, cancel-recurring, pending/cancel
├── coins/ / daily-bonus / user/balance / models / avatar-tokens
├── cron/                 renew-subscriptions, update-currency,
│                         cleanup-notifications, update-characters (тик персонажей выключен)
├── admin/                секрет ADMIN_SECRET: монеты, модерация, перевод, рекуррент
├── notifications/ favorites/ referral/ currency/ events/
│
│  ниже — наследство шаблона, не основной прод-контур NewVerse:
├── billing/  checkout/  webhook/stripe  webhook/muapi
├── unitpay/webhook
├── generation/  creations/  upload/  download/
└── app-instances/  (+ export на GitHub/Vercel)
```

### 3.3. Домен (`src/lib`)

Критичные модули прод-контура:

| Файл | Роль |
| --- | --- |
| `chatHelpers.ts`, `chatStream.ts` | Сборка контекста, стрим Kodik |
| `verseChatEconomy.ts`, `chatEconomy.ts` | VC, тарифы, лимиты контекста |
| `intentAnalyzer.ts`, `chatMemory.ts`, `advancedMemory.ts` | Intent и иерархия памяти |
| `messageEmbeddings.ts`, `memoryEmbeddings.ts` | RAG и семантический дедуп |
| `createya.ts`, `avatarModels.ts`, `avatarTokens.ts` | Аватары |
| `robokassa.ts`, `subscription.ts`, `subscriptionRenewal.ts` | Оплата и автопродление |
| `auth.ts`, `email.ts`, `emailVerification.ts` | Сессия и почта |
| `translate.ts`, `currencyRates.ts`, `logger.ts`, `metrika.ts` | Перевод, курсы, логи, цели |

Остатки шаблона: `stripe.js`, `services/ai.js` (MuAPI), `services/billing.js`, `standaloneConfig.js`, `registry.js`.

### 3.4. Данные (`prisma/schema.prisma`)

**Продуктовые модели:** `User`, `Account`, `Session`, `Character`, `Message`, `MessageEmbedding` (vector 1536), `Memory`, `CoreMemory`, `EpisodicMemory`, `MemoryEntry`, `WorldEvent`, `Persona`, `PersonaSelection`, `Favorite`, `Model`, `Transaction`, `Notification`, `PasswordResetToken`, `EmailVerificationToken`, `AnonymousSession`.

**Шаблон, до сих пор в схеме:** `Creation`, `AppInstance`, `VerificationToken` (NextAuth).

---

## 4. Внешняя архитектура

Сервисы, без которых прод NewVerse не работает или деградирует. Стрелка — кто инициирует вызов.

### 4.1. Критический контур (сайт стоит на этом)

| Сервис | Зачем | Куда ходит код | Секрет / идентификатор | Если упал |
| --- | --- | --- | --- | --- |
| **RelaxDev** | Хостинг Next.js (Docker) | входящий HTTPS newvers.ai | панель хоста | сайт недоступен |
| **PostgreSQL** (на RelaxDev / рядом) | Пользователи, чаты, память, платежи | `DATABASE_URL`, `DIRECT_URL` | Prisma | полный отказ |
| **KodikRouter** | Чат, саммари, intent, core, эмбеддинги, системный промпт | `https://api.kodikrouter.ru/v1` | `KODIKROUTER_API_KEY` | нет диалога и памяти |
| **CreateYa** | Генерация аватаров | `https://api.createya.ai` | `CREATEYA_API_KEY` | чат жив, создание аватара нет |
| **Robokassa** | Оплата VC и подписок, рекуррент, чеки 54-ФЗ | `auth.robokassa.ru` | `ROBOKASSA_*` | нет выручки |
| **Google Fonts** (next/font Inter) | Шрифт layout | `next/font/google` | нет ключа | страница рисуется fallback-шрифтом |

### 4.2. Аккаунт, почта, аналитика, операции

| Сервис | Зачем | Куда | Секрет | Если упал |
| --- | --- | --- | --- | --- |
| **Google Identity** | OAuth вход | NextAuth GoogleProvider | `GOOGLE_CLIENT_ID/SECRET` | остаётся вход по почте |
| **Resend** | Верификация и сброс пароля | API Resend, from `noreply@newvers.ai` | `RESEND_API_KEY` | нельзя подтвердить почту / сбросить пароль |
| **Yandex Metrika** | Счётчик и `reachGoal` оплат | `mc.yandex.ru`, id `112171267` | `NEXT_PUBLIC_YANDEX_METRIKA_ID` | продукт жив, нет аналитики |
| **Yandex Cloud Translate** | EN-поля карточек, админ/скрипт перевода | `translate.api.cloud.yandex.net` | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | EN-каталог не обновляется |
| **ЦБ РФ** | Курсы для пересчёта цен в UI | `www.cbr.ru/scripts/XML_daily.asp` | нет | селектор валют без свежего курса |
| **Better Stack (Logtail)** | Копия логов приложения | `LOGTAIL_INGESTING_HOST` | `LOGTAIL_SOURCE_TOKEN` | логи только в stdout RelaxDev |
| **cron-job.org** (или аналог) | Дёргает `/api/cron/*` | HTTPS на сайт с `CRON_SECRET` | секрет крона | не продлеваются подписки, не чистятся уведомления, не обновляется курс |

Cron-ручки:

| Метод | Путь | Задача |
| --- | --- | --- |
| GET/POST | `/api/cron/renew-subscriptions` | Списание Robokassa Recurring |
| GET/POST | `/api/cron/update-currency` | Курс ЦБ |
| GET/POST | `/api/cron/cleanup-notifications` | Удаление старых уведомлений |
| GET/POST | `/api/cron/update-characters` | Заготовка lifecycle; тик персонажей сейчас отключён |

### 4.3. Потоки (кто с кем говорит)

**Чат.** Браузер → `POST /api/chat/[id]` → Kodik `chat/completions` (выбранная модель) + служебные вызовы Gemma / 4o-mini / embeddings. Ответ стримится клиенту. Сообщения пишутся в PostgreSQL.

**Аватар.** Браузер → `POST /api/generate-avatar` → CreateYa `POST /v1/run` + poll `/v1/runs/{id}` → data URL в ответе, лимит в `User.tokensUsedThisMonth`.

**Оплата.** Браузер → `POST /api/payment/create` или `/api/subscription/create` → редирект на `auth.robokassa.ru`. Успех: Result URL `/api/payment/webhook` (ResultUrl2, `Password2`). Рекуррент: cron → Robokassa Recurring API. Цели Метрики: клиент после SuccessUrl.

**Почта.** Регистрация / forgot-password → Resend. Ссылки ведут на `NEXTAUTH_URL` или `https://newvers.ai`.

**Гость.** Cookie анонимной сессии, лимит `ANONYMOUS_MESSAGE_LIMIT` (по умолчанию 5), без аккаунта; чат всё равно идёт в Kodik.

### 4.4. Наследство шаблона (в коде есть, прод NewVerse на этом не держится)

| Сервис | Следы в репозитории | Статус |
| --- | --- | --- |
| **Stripe** | `src/lib/stripe.js`, `/api/billing/*`, `/api/webhook/stripe`, `/api/checkout` | шаблон биллинга |
| **MuAPI** | `src/lib/services/ai.js`, `/api/webhook/muapi`, `/api/generation`, `MUAPIAPP_API_KEY` | старый генератор картинок |
| **UnitPay** | `/api/unitpay/webhook`, `UNITPAY_SECRET_KEY` | альтернативный вебхук VC |
| **GitHub + Vercel** | `/api/app-instances/export` | экспорт инстанса шаблона |
| **Unsplash** | заглушка картинки в `services/ai.js` | не продукт |

Их удаление не описано в этом отчёте; для схемы «на чём стоит сайт» они не критичны.

---

## 5. Переменные окружения прод-контура

Из `.env.example` плюс ключ, который **используется в коде, но в example не указан**.

| Переменная | Сервис |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL (`connection_limit`, `pool_timeout` обязательны на RelaxDev) |
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` | сессии |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth |
| `ROBOKASSA_MERCHANT_ID`, `PASSWORD`, `PASSWORD2`, `PASSWORD3`, `TEST_MODE` | оплата |
| `KODIKROUTER_API_KEY` | чат (**нет в `.env.example`**) |
| `CHARACTER_PROMPT_MODEL` | модель промпта карточки |
| `ENABLE_RAG_EMBEDDINGS` | RAG, по умолчанию `false` |
| `CREATEYA_API_KEY`, `CREATEYA_API_URL` | аватары |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | почта |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | перевод |
| `NEXT_PUBLIC_YANDEX_METRIKA_ID` | Метрика |
| `LOGTAIL_SOURCE_TOKEN`, `LOGTAIL_INGESTING_HOST`, `LOG_LEVEL` | логи |
| `CRON_SECRET`, `ADMIN_SECRET` | крон и админ-API |
| `ANONYMOUS_MESSAGE_LIMIT`, `NOTIFICATION_RETENTION_DAYS`, `MEMORY_DEDUP_THRESHOLD` | лимиты |

SMTP-блок в example помечен как неиспользуемый: письма идут через Resend.

---

## 6. Зависимости продукта от внешних SLA

Порядок «что чинить первым», если сайт «лежит»:

1. RelaxDev / DNS / TLS
2. PostgreSQL (пул, `connection_limit`)
3. KodikRouter — чат
4. Robokassa — деньги (сайт при этом может открываться)
5. CreateYa — только аватары
6. Resend / Google — только вход и почта
7. Метрика, Translate, ЦБ, логи — наблюдаемость и второстепенный UX

Chat-экономика привязана к ценам Kodik (₽/1M) и CreateYa (кредиты). Смена тарифа провайдера сразу бьёт по марже; см. экономический отчёт.

---

*Собрано по коду репозитория на 30.09.2026. Секреты в файл не включались.*
