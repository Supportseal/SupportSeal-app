-- Billing robustness (issue #202): the latest Checkout Session per Workspace,
-- so a read can resolve the Stripe customer when the linking webhook was
-- lost. No backfill; cleared once the customer is linked.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "stripeCheckoutSessionId" TEXT;
