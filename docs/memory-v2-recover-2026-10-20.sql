-- Manual recovery of the four memory queues blocked on 2026-10-18..20.
-- Run ONLY after the image with the fact-budget / oversized-skip / NPC-subject fix is live:
-- on an older image the same jobs fail again identically.
-- Resets exactly these failed head jobs; never touches messages, facts or queued jobs.
-- Save the returned previous_attempts / previous_error_code as the recovery receipt.
--   cmvdvykg403m6t1jnvhuqamq2  seq 2    MEMORY_EXTRACT_INVALID:invalid_subject   (6 queued behind)
--   cmvfn3gwp1wpft1jnc9wiclvs  seq 78   MEMORY_EXTRACT_INPUT_TOO_LARGE           (50 queued behind)
--   cmvghunes00f3zuwdowg60d00  seq 83   MEMORY_EXTRACT_INPUT_TOO_LARGE           (10 queued behind)
--   cmvgsi2gk0ciyzuwdrhkao0sy  seq 101  MEMORY_EXTRACT_INPUT_TOO_LARGE           (8 queued behind)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
SELECT id FROM "ChatThread" WHERE id IN (
  SELECT "threadId" FROM "MemoryJob" WHERE id IN ('cmvdvykg403m6t1jnvhuqamq2', 'cmvfn3gwp1wpft1jnc9wiclvs',
    'cmvghunes00f3zuwdowg60d00', 'cmvgsi2gk0ciyzuwdrhkao0sy')
) ORDER BY id FOR UPDATE;
WITH previous AS (
  SELECT id, attempts, "errorCode" FROM "MemoryJob"
  WHERE id IN ('cmvdvykg403m6t1jnvhuqamq2', 'cmvfn3gwp1wpft1jnc9wiclvs', 'cmvghunes00f3zuwdowg60d00', 'cmvgsi2gk0ciyzuwdrhkao0sy')
    AND status = 'failed'
    AND ("errorCode" = 'MEMORY_EXTRACT_INPUT_TOO_LARGE' OR "errorCode" = 'MEMORY_EXTRACT_INVALID:invalid_subject')
  FOR UPDATE
)
UPDATE "MemoryJob" AS job SET status = 'retry', attempts = 0,
  "availableAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "startedAt" = NULL, "finishedAt" = NULL, "errorCode" = NULL
FROM previous WHERE job.id = previous.id
RETURNING job.id, job.status, previous.attempts AS previous_attempts, previous."errorCode" AS previous_error_code;
COMMIT;
