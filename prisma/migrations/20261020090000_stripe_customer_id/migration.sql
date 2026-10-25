-- Billing robustness (issue #202): the Workspace -> Stripe customer link that
-- webhook and lazy re-sync state is keyed by. No backfill: existing rows stay
-- NULL and link on their next checkout.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "stripeCustomerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_stripeCustomerId_key" ON "workspaces"("stripeCustomerId");
