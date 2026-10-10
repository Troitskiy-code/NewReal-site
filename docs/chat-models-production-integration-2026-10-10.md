# Каталог моделей в production — 10 октября 2026

SQL в production не применялся. Окна контекста не увеличивались.

Причина: код, который ограничивает гостевой вход бесплатным тарифом, ещё не выложен. В выложенном `src/lib/anonymousChat.ts` гостевой вход считается как `maxContextTokens - 400`. Подъём окна с 12000 до 20000 увеличил бы этот вход с 11600 до 19600. Локальная правка уже вызывает `resolveContextTokenBudget({ subscriptionType: "start", subscriptionEnd: null }, model)` и исключает тестовые имена из гостевого fallback, но она не закоммичена и в контейнер не входила.

## Выкладка гостевого ограничения

Проверено после обновления страницы проекта `newreal-site` в Relaxdev. Последняя выкладка — коммит `3a64d2b`, старт 10 октября 12:36:27, в заголовке проекта 12:39. Более поздней строки в истории нет.

`git log -S resolveContextTokenBudget` по `src/lib/anonymousChat.ts` пустой: этой строки нет ни в одном коммите. `HEAD` и `origin/main` — тот же `3a64d2b`. Рабочая копия содержит незакоммиченное изменение гостевого расчёта.

Публичный `https://newvers.ai/api/models` это подтверждает с другой стороны: в ответе нет поля `isTesting`, пять тестовых моделей отсутствуют, у девяти моделей `maxContextTokens` равен 12000.

Коммит, push и настройки деплоя не менялись.

## База

Снимок снят в Adminer, транзакция `READ ONLY`, `statement_timeout` 20 с, `lock_timeout` 5 с, в конце `ROLLBACK`. Часы базы: 10 октября 2026, 16:05:54 UTC, то есть 19:05:54 МСК. База — `default_db` кластера Diligent Finch. Идентификаторы девяти моделей совпали с ответом `/api/models`, поэтому это база, которую читает newvers.ai.

В таблице `Model` 9 строк. Все известные из них — эти девять. Неизвестных строк нет. Пяти тестовых моделей нет. У всех девяти `isActive = true`, `maxContextTokens = 12000`, `pricePer1MInput` и `pricePer1MOutput` пустые.

| id | name | displayName | priceVC | maxContextTokens |
| --- | --- | ---: | ---: | ---: |
| cmtk6gx0a0000fnzuvtdc4uuk | deepseek/deepseek-v4-flash | DeepSeek V4 Flash | 4 | 12000 |
| cmtk6gx5b0001fnzukoqajy8x | google/gemma-4-31b-it | Gemma 4 31B | 4 | 12000 |
| cmtk6gx7u0002fnzuk58nv1su | mistralai/mistral-small-2603 | Mistral Small 4 | 5 | 12000 |
| cmtk6gxcx0004fnzu1ceko583 | mistralai/mistral-small-3.1-24b-instruct | Mistral Small 3.1 24B | 11 | 12000 |
| cmtk6gxac0003fnzuktxojr1k | google/gemini-2.5-flash | Gemini 2.5 Flash | 12 | 12000 |
| cmtk6gxfe0005fnzuiox5pab4 | anthropic/claude-haiku-4.5 | Claude Haiku 4.5 | 34 | 12000 |
| cmtk6gxhy0006fnzump60rw39 | x-ai/grok-4.20 | Grok 4.20 | 36 | 12000 |
| cmtk6gxki0007fnzu1050c91p | openai/gpt-5.1 | GPT-5.1 | 50 | 12000 |
| cmtk6gxn10008fnzu4o1aylbg | mistralai/mistral-large-2407 | Mistral Large 2 | 63 | 12000 |

Связанный выбор — только `User.selectedModelId`. Персональные поля не читались. Выбор есть у 29 пользователей, у 600 его нет. Сумма по моделям равна 29, чужих id среди выбранных нет.

| name | пользователей с этим выбором |
| --- | ---: |
| google/gemma-4-31b-it | 12 |
| deepseek/deepseek-v4-flash | 7 |
| openai/gpt-5.1 | 3 |
| google/gemini-2.5-flash | 2 |
| mistralai/mistral-large-2407 | 2 |
| x-ai/grok-4.20 | 2 |
| mistralai/mistral-small-2603 | 1 |
| anthropic/claude-haiku-4.5 | 0 |
| mistralai/mistral-small-3.1-24b-instruct | 0 |

## Бэкап

До этой проверки самый новый физический бэкап был ручной, 9 октября 2026, 20:45. Он не покрывает данные 10 октября, поэтому перед будущим SQL его недостаточно.

Создан новый физический бэкап кластера Diligent Finch: ручной, 10 октября 2026, 19:07. Сначала панель показывала подготовку и создание. После обновления страницы он стоит в списке из пяти бэкапов без строки прогресса, рядом с прежними завершёнными копиями. Восстановление и скачивание не запускались. Логические бэкапы по-прежнему выключены.

Этот бэкап фиксирует состояние до изменения каталога. Если между ним и будущим SQL появятся новые данные, непосредственно перед SQL нужна ещё одна копия.

## Применение

Оба SQL не запускались: ни `20261010190000_chat_testing_models`, ни `20261010200000_chat_context_limits`. `prisma/seed.js`, `prisma db push` и история `_prisma_migrations` не трогались.

Сравнения после применения нет: каталог не менялся. Повторная проверка `/api/models` после SQL не требовалась; снятый до остановки ответ совпадает со снимком базы.

## Что остаётся

Сначала выложить гостевое ограничение и подтвердить, что в production контейнере именно этот код. Затем, уже после свежего бэкапа, применить оба SQL одной транзакцией. Пока этого нет, тестовые модели в выборе отсутствуют, а потолок девяти моделей остаётся 12000.
