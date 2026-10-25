-- CreateTable
-- Per-agent durable read receipts (FR-INBOX-04): absence of a receipt row
-- means unread, so pre-existing and concurrently arriving customer messages
-- are counted without a backfill. The composite PK makes repeated marks
-- idempotent (INSERT .. ON CONFLICT DO NOTHING); cascades keep receipts
-- tied to their membership and message lifecycles.
CREATE TABLE "message_read_receipts" (
    "membershipId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_read_receipts_pkey" PRIMARY KEY ("membershipId","messageId")
);

-- CreateIndex
CREATE INDEX "message_read_receipts_messageId_idx" ON "message_read_receipts"("messageId");

-- AddForeignKey
ALTER TABLE "message_read_receipts" ADD CONSTRAINT "message_read_receipts_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_read_receipts" ADD CONSTRAINT "message_read_receipts_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
