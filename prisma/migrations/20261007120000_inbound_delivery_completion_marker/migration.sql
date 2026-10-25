-- AlterTable
-- Completion marker for inbound deliveries (issue #102): committed in the
-- same transaction as the Message insert, so a RECEIVED row without it is a
-- crashed attempt the provider retry recovers instead of acking a duplicate
-- (threaded replies land on conversations that already have messages, so
-- "conversation has messages" was never valid completion proof).
ALTER TABLE "email_deliveries" ADD COLUMN "messageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_messageId_key" ON "email_deliveries"("messageId");
