-- Free daily quota (option 1A): production facts for the estimate.
-- Read-only: run the whole file in Adminer → "SQL-запрос". Every statement is a SELECT
-- inside a READ ONLY transaction that is rolled back at the end.
-- Only aggregates are returned: no e-mails, names, ids or message texts.
-- Timestamps are stored in UTC without a zone; days are counted in Europe/Moscow.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

-- Q1. Accounts and paying accounts (test invoices excluded).
WITH paid AS (
  SELECT pe."userId", min(pe."createdAt") AS first_paid
  FROM "PaymentEvent" pe
  LEFT JOIN "PaymentOrder" po ON po.provider = pe.provider AND po."invoiceId" = pe."invoiceId"
  WHERE coalesce(po."isTest", false) = false
  GROUP BY 1
)
SELECT
  (SELECT count(*) FROM "User") AS users_total,
  (SELECT count(*) FROM "User" WHERE "createdAt" >= now() - interval '30 days') AS users_new_30d,
  (SELECT count(*) FROM paid) AS payers_total,
  (SELECT count(*) FROM paid WHERE first_paid >= now() - interval '30 days') AS payers_first_30d,
  (SELECT count(*) FROM "User" WHERE "subscriptionEnd" > now() AND "subscriptionType" NOT IN ('start', 'none')) AS active_subscriptions;

-- Q2. Chat charges per user per Moscow day, last 30 days, payer vs free.
-- One "chat" transaction = one charged reply (send, continue or regenerate); refunded ones are deleted.
WITH paid AS (
  SELECT DISTINCT pe."userId"
  FROM "PaymentEvent" pe
  LEFT JOIN "PaymentOrder" po ON po.provider = pe.provider AND po."invoiceId" = pe."invoiceId"
  WHERE coalesce(po."isTest", false) = false
), d AS (
  SELECT t."userId",
    ((t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow')::date AS day,
    count(*) AS replies, sum(-t.amount) AS vc
  FROM "Transaction" t
  WHERE t.type = 'chat' AND t."createdAt" >= now() - interval '30 days'
  GROUP BY 1, 2
)
SELECT
  CASE WHEN d."userId" IN (SELECT "userId" FROM paid) THEN 'payer' ELSE 'free' END AS segment,
  count(DISTINCT d."userId") AS active_users,
  count(*) AS user_days,
  round(count(*)::numeric / 30, 1) AS avg_dau,
  sum(d.replies) AS replies,
  sum(d.vc) AS vc_spent,
  round(avg(d.replies), 1) AS avg_replies_per_day,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY d.replies) AS p50,
  percentile_cont(0.75) WITHIN GROUP (ORDER BY d.replies) AS p75,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY d.replies) AS p90,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY d.replies) AS p99,
  max(d.replies) AS max_replies,
  count(*) FILTER (WHERE d.replies >= 5) AS days_ge5,
  count(*) FILTER (WHERE d.replies >= 10) AS days_ge10,
  count(*) FILTER (WHERE d.replies >= 15) AS days_ge15,
  count(*) FILTER (WHERE d.replies >= 20) AS days_ge20
FROM d
GROUP BY 1;

-- Q3. Real AI cost per chat reply, last 14 days, by plan and model.
SELECT
  coalesce(e."subscriptionType", '-') AS plan,
  e.model,
  e.purpose,
  e.outcome,
  count(*) AS events,
  round(avg(e."inputTokens")) AS avg_in_tokens,
  round(avg(e."outputTokens")) AS avg_out_tokens,
  round(avg(coalesce(e."reportedCostRub", e."estimatedCostRub"))::numeric, 4) AS avg_cost_rub,
  round(sum(coalesce(e."reportedCostRub", e."estimatedCostRub"))::numeric, 2) AS total_cost_rub,
  sum(e."chargedVC") AS charged_vc
FROM "AiCostEvent" e
WHERE e."createdAt" >= now() - interval '14 days'
GROUP BY 1, 2, 3, 4
ORDER BY total_cost_rub DESC NULLS LAST
LIMIT 60;

-- Q4. Full AI cost per charged reply (side calls such as memory included), last 14 days.
WITH ops AS (
  SELECT e."operationId",
    max(coalesce(e."subscriptionType", '-')) AS plan,
    sum(coalesce(e."reportedCostRub", e."estimatedCostRub", 0)) AS cost_rub,
    sum(e."chargedVC") AS charged_vc
  FROM "AiCostEvent" e
  WHERE e."createdAt" >= now() - interval '14 days' AND e.audience = 'user'
  GROUP BY 1
)
SELECT plan,
  count(*) FILTER (WHERE charged_vc > 0) AS charged_ops,
  round(sum(cost_rub)::numeric, 2) AS cost_rub,
  round((sum(cost_rub) / nullif(count(*) FILTER (WHERE charged_vc > 0), 0))::numeric, 4) AS cost_per_charged_op
FROM ops
GROUP BY 1
ORDER BY 2 DESC;

-- Q5. Funnel of accounts created 8–60 days ago (each had at least 7 days to act).
WITH paid AS (
  SELECT pe."userId", min(pe."createdAt") AS first_paid
  FROM "PaymentEvent" pe
  LEFT JOIN "PaymentOrder" po ON po.provider = pe.provider AND po."invoiceId" = pe."invoiceId"
  WHERE coalesce(po."isTest", false) = false
  GROUP BY 1
), cohort AS (
  SELECT u.id, u."createdAt", u."verseCoins", p.first_paid
  FROM "User" u LEFT JOIN paid p ON p."userId" = u.id
  WHERE u."createdAt" < now() - interval '8 days' AND u."createdAt" >= now() - interval '60 days'
), usage AS (
  SELECT c.id,
    count(t.id) AS replies_total,
    count(t.id) FILTER (WHERE c.first_paid IS NULL OR t."createdAt" < c.first_paid) AS replies_before_pay,
    count(DISTINCT ((t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow')::date) AS active_days,
    max(t."createdAt") AS last_reply
  FROM cohort c LEFT JOIN "Transaction" t ON t."userId" = c.id AND t.type = 'chat'
  GROUP BY c.id
)
SELECT
  count(*) AS cohort_users,
  count(*) FILTER (WHERE u.replies_total > 0) AS sent_any,
  count(*) FILTER (WHERE u.replies_before_pay >= 10) AS reached_10_free,
  count(*) FILTER (WHERE c.first_paid IS NULL AND c."verseCoins" < 5) AS free_now_below_5vc,
  count(*) FILTER (WHERE c.first_paid IS NULL AND c."verseCoins" < 5
                   AND u.last_reply < now() - interval '7 days') AS free_below_5vc_gone_7d,
  count(*) FILTER (WHERE c.first_paid IS NOT NULL) AS payers,
  count(*) FILTER (WHERE c.first_paid < c."createdAt" + interval '7 days') AS paid_within_7d,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY u.replies_before_pay) FILTER (WHERE c.first_paid IS NOT NULL) AS median_replies_before_pay,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.first_paid - c."createdAt") / 3600) FILTER (WHERE c.first_paid IS NOT NULL) AS median_hours_to_pay,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY u.active_days) FILTER (WHERE u.replies_total > 0) AS median_active_days
FROM cohort c JOIN usage u ON u.id = c.id;

-- Q6. Return on day 1 and day 7 after sign-up (same cohort), payer vs free.
WITH paid AS (
  SELECT DISTINCT pe."userId"
  FROM "PaymentEvent" pe
  LEFT JOIN "PaymentOrder" po ON po.provider = pe.provider AND po."invoiceId" = pe."invoiceId"
  WHERE coalesce(po."isTest", false) = false
), cohort AS (
  SELECT u.id, u."createdAt"::date AS d0, (u.id IN (SELECT "userId" FROM paid)) AS is_payer
  FROM "User" u
  WHERE u."createdAt" < now() - interval '8 days' AND u."createdAt" >= now() - interval '60 days'
), act AS (
  SELECT DISTINCT t."userId", t."createdAt"::date AS d
  FROM "Transaction" t
  WHERE t.type = 'chat' AND t."createdAt" >= now() - interval '61 days'
)
SELECT CASE WHEN c.is_payer THEN 'payer' ELSE 'free' END AS segment,
  count(*) AS users,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a."userId" = c.id AND a.d = c.d0)) AS active_d0,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a."userId" = c.id AND a.d = c.d0 + 1)) AS active_d1,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a."userId" = c.id AND a.d BETWEEN c.d0 + 6 AND c.d0 + 8)) AS active_d7
FROM cohort c
GROUP BY 1;

-- Q7. Daily bonus use, last 30 days, payer vs free.
WITH paid AS (
  SELECT DISTINCT pe."userId"
  FROM "PaymentEvent" pe
  LEFT JOIN "PaymentOrder" po ON po.provider = pe.provider AND po."invoiceId" = pe."invoiceId"
  WHERE coalesce(po."isTest", false) = false
)
SELECT CASE WHEN t."userId" IN (SELECT "userId" FROM paid) THEN 'payer' ELSE 'free' END AS segment,
  count(*) AS claims, count(DISTINCT t."userId") AS users, sum(t.amount) AS vc_granted,
  round(avg(t.amount), 1) AS avg_vc
FROM "Transaction" t
WHERE t.type = 'daily_bonus' AND t."createdAt" >= now() - interval '30 days'
GROUP BY 1;

-- Q8. Guest sessions, last 30 days.
SELECT
  count(*) AS sessions,
  count(*) FILTER (WHERE "messagesCount" >= 1) AS sent_any,
  count(*) FILTER (WHERE "messagesCount" >= 5) AS hit_limit_5,
  count(*) FILTER (WHERE "transferredToUserId" IS NOT NULL) AS registered_after,
  count(*) FILTER (WHERE "messagesCount" >= 5 AND "transferredToUserId" IS NOT NULL) AS hit_limit_then_registered
FROM "AnonymousSession"
WHERE "createdAt" >= now() - interval '30 days';

ROLLBACK;
