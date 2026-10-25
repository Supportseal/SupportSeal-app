-- Installation signal (issue #192): last time a Product's widget config was
-- loaded from (LOADED) or refused for (REJECTED) a hostname. Hostname and
-- timestamp only; no visitor data. Purely additive: a new enum and table, no
-- change to existing rows. Reversible with:
--   DROP TABLE "widget_host_signals"; DROP TYPE "WidgetHostOutcome";

-- CreateEnum
CREATE TYPE "WidgetHostOutcome" AS ENUM ('LOADED', 'REJECTED');

-- CreateTable
CREATE TABLE "widget_host_signals" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "outcome" "WidgetHostOutcome" NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_host_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "widget_host_signals_productId_host_outcome_key" ON "widget_host_signals"("productId", "host", "outcome");

-- CreateIndex
CREATE INDEX "widget_host_signals_productId_outcome_lastSeenAt_idx" ON "widget_host_signals"("productId", "outcome", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "widget_host_signals" ADD CONSTRAINT "widget_host_signals_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
