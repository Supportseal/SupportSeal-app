-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('RECEIVED', 'IGNORED', 'SENT', 'FAILED', 'REJECTED');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "emailMessageId" TEXT,
ADD COLUMN "emailReplyToken" TEXT;

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "conversationId" TEXT,
    "direction" "EmailDirection" NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL,
    "providerMessageId" TEXT,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_emailReplyToken_key" ON "conversations"("emailReplyToken");

-- CreateIndex
CREATE INDEX "conversations_emailMessageId_idx" ON "conversations"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_direction_providerMessageId_key" ON "email_deliveries"("direction", "providerMessageId");

-- CreateIndex
CREATE INDEX "email_deliveries_conversationId_idx" ON "email_deliveries"("conversationId");

-- CreateIndex
CREATE INDEX "email_deliveries_productId_idx" ON "email_deliveries"("productId");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
