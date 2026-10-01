# Ручной чеклист владельца: цели Метрики покупок

Не создавайте цели и не гоняйте тестовые оплаты в production-счётчик из агента. Кабинет из этой среды не открывался.

## Счётчик и отладка

1. Счётчик сайта: `112171267`. Для песочницы используйте отдельный тестовый ID в `NEXT_PUBLIC_YANDEX_METRIKA_ID`, не 112171267.
2. В кабинете должны существовать **целевые события** с именами:
   - `subscription_success`
   - `subscription_dialog`
   - `subscription_history` (DB-план `story`)
   - `subscription_universe`
   - `vc_purchase_success`
3. Включите `_ym_debug=1` (или `?_ym_debug=1`) в браузере владельца и смотрите вызовы `reachGoal` в консоли отладки Метрики.

## Проверка после деплоя (только тестовый счётчик или перехват)

4. Примените миграцию `prisma/migrations/20261001210000_payment_event_analytics` **до** выкладки кода, который читает `planId`/`amountRub`.
5. Одна покупка VC → одно событие `vc_purchase_success` после server-confirmed webhook, не по `payment=success` в URL.
6. Подписка dialog / history / universe → `subscription_success` плюс соответствующая плановая цель. Доход (`order_price`) только у `subscription_success` / VC, не у плановой цели.
7. Primary tag.js может краснеть в F12; при этом fallback `mc.yandex.ru` должен создать **новый** запрос, не переписывать `src` старого script.
8. Поздний ResultURL (> 24 с) после reload страницы: баннер и цель используют одно и то же confirmed invoice.
9. Автопродление (`subscription_renewal`) не должно выглядеть как новая покупка в целях.

## Чего этот чеклист не доказывает

- Появление конверсии в отчётах Яндекса (задержка, фильтрация, блокировки).
- Отсутствие красной строки `ERR_CONNECTION_CLOSED` у посетителей.
- Exactly-once доставку при timeout callback.

P0-ротация секретов остаётся отдельной операторской задачей.
