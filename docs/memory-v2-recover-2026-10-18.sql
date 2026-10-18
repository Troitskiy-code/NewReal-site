-- Manual recovery after deploying the validated-candidate extraction fix.
-- Do NOT run against 9bc8111 or an earlier image: the same candidates would fail again.
-- Only the two observed failed jobs are reset. Never clears messages, facts or queued jobs.
-- Save the returned previous_attempts / previous_error_code as the recovery receipt.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
SELECT id FROM "ChatThread" WHERE id IN (
  SELECT "threadId" FROM "MemoryJob" WHERE id IN ('cmvdlrg32001gjbokici1tb56', 'cmvdmo54j00mpjbokg3dh7nvz')
) ORDER BY id FOR UPDATE;
WITH previous AS (
  SELECT id, attempts, "errorCode" FROM "MemoryJob"
  WHERE id IN ('cmvdlrg32001gjbokici1tb56', 'cmvdmo54j00mpjbokg3dh7nvz')
    AND status = 'failed'
    AND ("errorCode" IN ('MEMORY_EXTRACT_PROVIDER_ERROR', 'MEMORY_EXTRACT_PROVIDER_TIMEOUT', 'MEMORY_EXTRACT_INVALID')
      OR "errorCode" LIKE 'MEMORY_EXTRACT_INVALID:%')
  FOR UPDATE
)
UPDATE "MemoryJob" AS job SET status = 'retry', attempts = 0,
  "availableAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "startedAt" = NULL, "finishedAt" = NULL, "errorCode" = NULL
FROM previous WHERE job.id = previous.id
RETURNING job.id, job.status, previous.attempts AS previous_attempts, previous."errorCode" AS previous_error_code;
COMMIT;
