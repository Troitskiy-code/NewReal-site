-- CreateTable
CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_token_key" ON "EmailVerificationToken"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Existing users and Google accounts stay verified so the launch does not lock them out.
UPDATE "User"
SET "emailVerified" = COALESCE("emailVerified", "createdAt", CURRENT_TIMESTAMP)
WHERE "emailVerified" IS NULL
  AND (
    "createdAt" < TIMESTAMPTZ '2026-09-11 07:00:00+00'
    OR EXISTS (
      SELECT 1 FROM "Account"
      WHERE "Account"."userId" = "User"."id"
        AND "Account"."provider" = 'google'
    )
  );
