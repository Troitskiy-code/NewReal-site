# SEC-04: служебные URL и приватность аналитики

Дата: 8 октября 2026. Статус: исправления и локальная приёмка готовы; выкладка,
проверка действующей библиотеки/счётчика и удаление старых URL из поиска остаются.
Ни production, ни реклама, ни кабинет Вебмастера этой задачей не изменялись.

## Проблема

Возвраты оплаты получали индексируемые metadata витрины. Canonical не запрещает
индексацию исходного адреса. Метрика могла увидеть подпись, Shp_userId и invoice
до клиентской очистки, а reset/verify-email содержат токен в пути.
При отказе storage адрес необходимо сохранять для восстановления покупки.

## Серверное исправление

- `src/lib/urlPrivacy.ts`: единая политика платёжных ключей, приватных query
  и токеновых путей; регистр, повторяющиеся/пустые параметры и кодированные пути.
- `src/proxy.js`: приватные страницы и локализующий redirect получают
  `X-Robots-Tag: noindex, follow`, `Referrer-Policy: no-referrer`, `private, no-store`.
  Для остальных страниц применяется `strict-origin`, включая переходы внутри сайта.
- Proxy передаёт metadata только boolean `x-nv-private-url`; значение заголовка
  клиента перезаписывается. Полный входной URL не копируется в новый заголовок.
- `src/lib/seo.ts` и корневой layout: первоначальные robots/referrer metadata
  согласованы с HTTP-политикой; verify-email сохраняет HTML nofollow.
  Чистые RU/EN `/coins` и `/pricing` по-прежнему index/follow с чистым canonical.

Нет серверного удаления invoice или redirect на очищенную витрину: восстановление
покупки остаётся в существующем механизме. API подтверждения оплаты не изменялся.

## Клиентское исправление

- Очищаются платёжные параметры, user ID, токены/credentials, hash и токеновая
  часть reset/verify-email. Обычные UTM/yclid сохраняются. `utm_referrer`, который SDK
  может трактовать как подмену источника, ограничен HTTP(S) origin.
- В init передаются очищенные `url` и `referrer`, включён `defer`. Одного defer
  недостаточно: открытый SDK отправляет технический запрос и при этом параметре.
  Соответствие `url/referrer` внутренним forceUrl/forceReferrer сверено по исходникам.
- Явный `hit` задаёт безопасный URL SDK до уведомления ready-подписчиков.
  Он синхронизируется при смене пути и перед каждой нашей отправкой цели;
  одинаковый безопасный URL не создаёт повторный просмотр.
- Цели, вызванные до готовности, ждут init, вместо помещения перед hit в сырой ym queue.
  Покупки сохраняют отдельный server-confirmed механизм и callback/retry.
- Отключены автоматические clickmap, trackLinks, trackHash, Вебвизор, отправка
  заголовков и Yandex Tag Manager. Карта кликов и внешние ссылки читают адреса
  напрямую; эти дополнительные данные больше не собираются.
  Явные цели покупки и вовлечения этим не отключены; accurateTrackBounce сохранён.
- Script и noscript pixel имеют `referrerPolicy="no-referrer"`.
- Клиентская очистка платёжного URL использует общий список ключей, но по-прежнему
  выполняется только после сохранения очереди и session-баннера. При отказе обеих
  storage записи цель обрабатывается в памяти, а invoice остаётся в URL для reload.

Изменены `metrikaLoader.ts`, `metrika.ts`, `YandexMetrika.tsx`, `purchaseGoalRuntime.ts`.
Метод проверки оплаты, доверие только PaymentEvent текущего пользователя,
ограничения retry и изоляция очереди между аккаунтами сохранены.

## Выполненные проверки

- `npm run verify:sec04`: 90 проверок чистых/платёжных RU/EN адресов, aliases,
  повторов, токеновых путей, referrer, credentials, nested utm_referrer.
- `npm run verify:metrika`: 100 проверок, включая безопасный init/hit до capture,
  обновление URL перед целью и отсутствие маркеров в SDK-вызовах.
- `METRIKA_TEST_BROWSER_CHANNEL=msedge npm run verify:metrika:browser`: 55 проверок.
  Реальный локальный Next/Edge: HTTP/HTML robots, canonical, referrer, no-store,
  spoofed header, redirect; VC/подписки, fallback, pending/чужой/500/logout,
  webhook позднее 24 секунд, полный отказ записи storage и восстановление reload,
  reset/verify-email RU/EN с приватным входящим referrer.
- `verify:acquisition`: 21; `verify:p0-p1`: 40; `verify:p0-security`: 118;
  `verify:seo`: 91. Все passed.
- TypeScript без incremental и ESLint изменённых файлов: exit 0.
- Синтетическая production-сборка (`build-synthetic.mjs`): exit 0.
  Использованы синтетические env и недоступная тестовая БД; живая БД не проверялась.
- Финальный `git diff --check` для файлов задачи и проверка пробелов новых файлов:
  exit 0. Финальный повтор URL/Метрика: 90/100 passed.

## Границы доказательств

В браузере все запросы Яндекса перехвачены до навигации; счётчик только 999001.
Используется подставной tag, моделирующий технический init, hit и URL цели по
открытому SDK; проверяются реальные перехваченные запросы этого подставного tag.
Это не сетевой прогон сегодняшнего production tag.js и не проверка доставки
в кабинет. Чтение публичного tag.js с обоих mc-доменов на этой машине завершилось
TLS EOF; исходники SDK прочитаны из официального репозитория Yandex.
Проверку фактической библиотеки после выкладки не объявлять выполненной.

Подтверждения покупок в браузерном тесте подставные, production-БД и платёжный
webhook не вызывались. При полном отказе storage сохраняется прежнее ограничение:
дедупликация внутри документа есть, exactly-once между вкладками/reload нет.
Фильтрация известных ключей не доказывает отсутствие произвольных персональных
данных в неизвестных новых параметрах; новые форматы ссылок требуют проверки.

## Действия после публикации

1. Проверить действующие RU/EN платёжные ответы, reset/verify-email и чистые витрины.
2. На работающей библиотеке проверить первый запрос, goal и HTTP Referer:
   нет подписи, Shp_userId, invoice или reset/verify token; UTM/yclid сохранены.
   Доставку покупки сверить при следующей реальной покупке, без отправки
   искусственных конверсий в рабочий счётчик ради этого теста.
3. После подтверждения noindex удалить из поиска 21 перечисленный приватный/
   служебный URL, два возврата оплаты и отдельно найденную ссылку сброса пароля.
   Не публиковать их токены/подписи и не включать в массовый переобход.
4. Сравнить новый снимок Вебмастера 15–22 октября с 8 октября.

Новые production env, миграции и cron не нужны. Коммит/push не выполнялись.
Параллельная задача памяти не включена в эту реализацию.

## Первичные источники

- [Yandex: init и defer](https://yandex.ru/support/metrica/ru/code/counter-initialize).
- [Yandex: hit и options.referer](https://yandex.ru/support/metrica/ru/objects/hit).
- [SDK: технический init](https://github.com/yandex/metrica-tag/blob/main/src/providers/hit/hit.ts).
- [SDK: ключи url/referrer](https://github.com/yandex/metrica-tag/blob/main/src/providers/counterOptions/counterOptions.ts).
- [SDK: искусственные просмотры](https://github.com/yandex/metrica-tag/blob/main/src/providers/artificialHit/artificialHit.ts).
- [SDK: источник URL цели](https://github.com/yandex/metrica-tag/blob/main/src/providers/goal/goal.ts).
- [SDK: карта кликов читает location](https://github.com/yandex/metrica-tag/blob/main/src/providers/clickmap/clickmap.ts).

Перед изменениями прочитаны локальные руководства Next.js 16.4 по Proxy,
generateMetadata, request/response headers и referrer metadata.
