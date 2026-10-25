-- AlterTable
ALTER TABLE "email_deliveries" ADD COLUMN "agentMessageId" TEXT;

-- DropIndexes
DROP INDEX "email_deliveries_direction_providerMessageId_key";

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_agentMessageId_key" ON "email_deliveries"("agentMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_direction_productId_providerMessageId_key" ON "email_deliveries"("direction", "productId", "providerMessageId");
