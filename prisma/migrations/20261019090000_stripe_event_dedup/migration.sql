-- Billing robustness (issue #202): durable Stripe-webhook dedup and the
-- Workspace -> Stripe subscription link used by lazy re-sync.
--
-- ProcessedStripeEvent: one row per accepted Stripe event id. The webhook
-- inserts a row BEFORE processing, stamps completedAt after success, and
-- deletes the row if the claim owner's processing fails. Duplicates of a
-- completed event are acked without reprocessing (a late redelivery must not
-- revert newer lifecycle state); duplicates of an uncompleted claim (in
-- flight or crashed) process again so a retry racing a failure is not lost.
-- Rows older than 30 days are pruned opportunistically — no cron.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "stripeSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_stripeSubscriptionId_key" ON "workspaces"("stripeSubscriptionId");

-- CreateTable
CREATE TABLE "processed_stripe_events" (
    "eventId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "processed_stripe_events_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "processed_stripe_events_receivedAt_idx" ON "processed_stripe_events"("receivedAt");
