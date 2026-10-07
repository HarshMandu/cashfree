CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "ErpSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');
CREATE TYPE "ErpOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE "PaymentOrder" (
  "id" UUID NOT NULL,
  "studentId" TEXT NOT NULL,
  "erpReferenceId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "cashfreeOrderId" TEXT NOT NULL,
  "paymentSessionId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
  "erpSyncStatus" "ErpSyncStatus" NOT NULL DEFAULT 'PENDING',
  "lastCashfreeEventAt" TIMESTAMP(3),
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentOrder_cashfreeOrderId_key" ON "PaymentOrder"("cashfreeOrderId");
CREATE UNIQUE INDEX "PaymentOrder_idempotencyKey_key" ON "PaymentOrder"("idempotencyKey");

CREATE TABLE "PaymentTransaction" (
  "id" UUID NOT NULL,
  "paymentOrderId" UUID NOT NULL,
  "cashfreePaymentId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "PaymentStatus" NOT NULL,
  "paymentMethod" TEXT,
  "bankReference" TEXT,
  "paymentTime" TIMESTAMP(3),
  "providerEventAt" TIMESTAMP(3),
  "rawResponse" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentTransaction_paymentOrderId_fkey" FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentTransaction_cashfreePaymentId_key" ON "PaymentTransaction"("cashfreePaymentId");
CREATE INDEX "PaymentTransaction_paymentOrderId_idx" ON "PaymentTransaction"("paymentOrderId");

CREATE TABLE "WebhookEvent" (
  "id" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT,
  "cashfreeOrderId" TEXT,
  "payload" JSONB NOT NULL,
  "processed" BOOLEAN NOT NULL DEFAULT false,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");
CREATE INDEX "WebhookEvent_cashfreeOrderId_idx" ON "WebhookEvent"("cashfreeOrderId");

CREATE TABLE "ErpStatusOutbox" (
  "id" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "paymentOrderId" UUID NOT NULL,
  "status" "PaymentStatus" NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "ErpOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "ErpStatusOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ErpStatusOutbox_paymentOrderId_fkey" FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ErpStatusOutbox_eventId_key" ON "ErpStatusOutbox"("eventId");
CREATE INDEX "ErpStatusOutbox_state_nextAttemptAt_idx" ON "ErpStatusOutbox"("state", "nextAttemptAt");
