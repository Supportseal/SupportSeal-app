-- New-message email alerts for agents (docs/design/agent-alerts.md).

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "emailOnNewConversation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailOnCustomerReply" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "agentAlertedAt" TIMESTAMP(3);

-- Existing customer messages predate the feature: mark them handled so the
-- first sweep after deploy does not email about old messages.
UPDATE "messages" SET "agentAlertedAt" = "createdAt" WHERE "kind" = 'CUSTOMER';

-- CreateIndex
CREATE INDEX "messages_kind_agentAlertedAt_createdAt_idx" ON "messages"("kind", "agentAlertedAt", "createdAt");
