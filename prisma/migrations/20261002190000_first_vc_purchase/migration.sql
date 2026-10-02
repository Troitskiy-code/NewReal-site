-- Apply before deploying code that reads FirstVcPurchase.
CREATE TABLE "FirstVcPurchase" (
  "userId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "checkout" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FirstVcPurchase_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "FirstVcPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FirstVcPurchase_invoiceId_key" ON "FirstVcPurchase"("invoiceId");
