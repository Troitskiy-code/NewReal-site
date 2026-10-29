ALTER TABLE public."CharacterTranslation" ADD COLUMN IF NOT EXISTS "pipelineHash" TEXT;
ALTER TABLE public."CharacterTranslation" ADD COLUMN IF NOT EXISTS "qualityReviewedAt" TIMESTAMP(3);
CREATE TABLE IF NOT EXISTS public."CharacterTranslationJob" (
 "id" TEXT PRIMARY KEY,"characterId" TEXT NOT NULL,"locale" TEXT NOT NULL,"sourceHash" TEXT NOT NULL,"policyHash" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'queued',"attempts" INTEGER NOT NULL DEFAULT 0,"nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseToken" TEXT,"leaseUntil" TIMESTAMP(3),"checkpoint" JSONB NOT NULL DEFAULT '{}',"errorCode" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CharacterTranslationJob_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES public."Character"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CharacterTranslationJob_identity_key" ON public."CharacterTranslationJob"("characterId","locale","sourceHash","policyHash");
CREATE INDEX IF NOT EXISTS "CharacterTranslationJob_state_nextAttemptAt_leaseUntil_idx" ON public."CharacterTranslationJob"("state","nextAttemptAt","leaseUntil");
CREATE TABLE IF NOT EXISTS public."CharacterTranslationBudget" ("id" TEXT PRIMARY KEY,"usedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0);
