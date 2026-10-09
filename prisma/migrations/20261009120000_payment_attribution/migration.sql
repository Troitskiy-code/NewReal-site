-- Apply before deploying DATA-01 checkout/status/analytics code.
-- No baseline/history changes and no alterations to grants or existing payments.
BEGIN;
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "planId" TEXT,
    "packageId" INTEGER,
    "period" TEXT,
    "amountRub" INTEGER NOT NULL,
    "attribution" JSONB,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentOrder_provider_invoiceId_key" ON "PaymentOrder"("provider", "invoiceId");
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");
CREATE TABLE "PaymentGoalReceipt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentGoalReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentGoalReceipt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "PaymentEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentGoalReceipt_eventId_goal_key" ON "PaymentGoalReceipt"("eventId", "goal");
COMMIT;
