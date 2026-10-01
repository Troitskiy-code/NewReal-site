# Повторная приёмка P0 после второго исправления Cursor — 1 октября 2026

**Вердикт:** предыдущие конкретные воспроизведения устранены. Остался один дефект защитного контракта: неизвестные ошибки могут обходить `safeErrorFields` через автоматическое распознавание контекста в `errorLog`. Поэтому полную готовность кода P0 пока не подтверждаю. Production-ротация остаётся pending.

Реальные production credentials, БД, OAuth, почта и платёжные HTTP-запросы не использовались. Изменены только документы и независимые проверочные harness; продуктовый код, реальный Git index, refs и objects не изменялись. Коммит/push не выполнялись.

## Подтверждено независимо

- `npm run verify:p0-security` — 92 checks passed.
- `npm run verify:p0-p1` — 40 checks passed.
- `npx tsc --noEmit`, ESLint изменённых TS/JS с `--max-warnings 0`, `git diff --check` — exit 0.
- `npm run build` — exit 0 с синтетическими NEXTAUTH_SECRET/DATABASE_URL/DIRECT_URL, БД `127.0.0.1:1`, пустыми внешними ключами из `.env.example`. Сборка не проверяет живую схему. Sitemap/DDL выводят только category/name. Осталось прежнее предупреждение трассировки Turbopack.
- Прежний `docs/p0-security-independent-repro.mjs`: все leakedToConsole/leakedToSink=false; JSON password, обычные Error, исходные Bearer/DSN и цикл массива безопасны. Корневой синтетический live-key обнаружен, scannerExit=1.
- Изменения auth/subscription/sitemap убрали прежние прямые error dumps; forgot-password выводит домен. Robokassa не выводит response bodies; renew cron пишет агрегаты. Runbook уточняет реальных читателей DIRECT_URL и различает отзыв credentials и удаление копий.
- Дополнительная проверка staged: секретообразный синтетический маркер присутствовал **только в staged blob**, рабочий JSON был безопасным. Сканер обнаружил его. Проверка использовала отдельные временные GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY и не меняла основной индекс/objects.

## Остался дефект: `errorLog` принимает неизвестную ошибку за контекст

Файлы:

- `src/lib/logger.ts:44–48,59–79`: `isLogContext` принимает plain object, если эвристика `isErrorEnvelope` его не распознала; `formatErrorLog` затем сохраняет его поля через обычный redactor.
- `src/lib/redactSensitive.ts:169–177`: объект с message распознаётся как ошибка только вместе со stack либо при дополнительных признаках meta/provider. `{message: …}` и `{name: "Error", message: …}` без stack остаются контекстом.
- `src/app/api/auth/register/route.ts:106`, `reset-password/route.ts:40,89`: catch передаёт unknown напрямую в `errorLog`, без исправленного `toSafeDiagnostic`.
- `src/app/api/auth/resend-verification/route.ts:43`: ошибку вкладывают в `{userId, error}`. Аналогичная форма есть в verify-email. Для вложенной не-Error строки/объекта строгий диагностический контракт не применяется.

Синтетические случаи:

```text
errorLog("Auth", "failure", {message: SYN})
errorLog("Auth", "failure", {name: "Error", message: SYN})
errorLog("Auth", "failure", {userId: "synthetic-user", error: SYN})
```

Во всех трёх случаях SYN сохраняется в console и mock Logtail. Отдельный `reportAuthFailure(..., {message: SYN})` уже безопасен — проблема в путях, которые его обходят.

Проверены также **настоящие handlers из актуального исходника** с mock-зависимостями:

- register.POST и reset-password.GET: mock БД бросает `{message: SYN}`. Ответ HTTP 500 безопасный, но SYN остаётся в console и mock sink.
- resend-verification.POST: mock отправки бросает строку SYN. Внутренний catch возвращает безопасный 500, но вложенный error печатается целиком в обоих каналах.
- Обычный Error в той же проверке безопасен.

Это не доказательство фактической production-утечки и не утверждение, что Prisma обычно бросает такой объект. Это воспроизведение незакрытого ранее требования: неизвестный caught error должен давать фиксированную категорию без содержимого. Проверки Cursor покрывают этот контракт отдельно для helper, но не для всех рабочих мест его применения.

**Минимальная доработка для Cursor:**

1. В чувствительных catch текущей P0-задачи передавать error через `toSafeDiagnostic`/`safeErrorFields` или соответствующий `report…Failure`. Безопасный контекст, например `{userId}`, передавать отдельно. Не вкладывать unknown error в обычный контекст.
2. Убрать зависимость безопасности caught errors от эвристического различения error/context. Можно сохранить API обычных контекстов и явно преобразовывать ошибки в местах вызова; большой рефакторинг не требуется.
3. Добавить runtime-регрессии message-only объекта, объекта name+message без stack и вложенной thrown-string на настоящих handlers; проверить оба канала. Добавление ещё одной эвристики само по себе не закрывает контракт произвольного unknown.

## Неблокирующее для безопасности замечание: staged deletion

`scripts/verify-p0-security.ts:584,613–618` включает staged-удалённый файл в набор, затем пытается читать `git show :path`. У удалённого файла закономерно нет staged blob; сканер считает это ошибкой чтения и отказывает обычному удалению файла.

На отдельном временном индексе удалён `src/lib/email.ts`; реальный файл не менялся. Сканер вернул exit 1 с `rule=readable`. Это ложный отказ проверки, **не новая утечка**.

Рекомендация: получать staged статусы через `--name-status -z`/`--diff-filter` и учитывать удаления отдельно; реальные ошибки чтения существующих кандидатов оставлять fail. Не изменять основной index для тестов.

## Артефакты проверки

- `docs/p0-security-second-independent-repro.mjs` и `.json` — оставшийся путь утечек; результаты с leaked=true показывают дефект. Exit 0 означает успешное воспроизведение, не приёмку P0.
- `docs/p0-security-staged-scan-probe.cjs` и `.json` — staged-only обнаружение и ложный отказ удаления. Временные файлы, индекс и objects удалены после проверки.
- Прежний harness сохранён и повторён; его успешный результат не оспаривается.

Следующий шаг ограничен безопасной обработкой unknown в catch и соответствующими регрессиями. Метрика/P1/экономика и production-ротация не входят в эту доработку. После исчезновения оставшихся утечек кодовую часть можно принять отдельно; общий P0 закрывается после подтверждённой ротации.
