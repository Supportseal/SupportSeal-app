-- Ticket numbers (issue #141): a persistent, human-facing per-Workspace
-- reference for every Conversation. The counter lives on the Workspace row;
-- the application increments it inside the Conversation-creating
-- transaction, so the row lock serialises concurrent creators.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "nextTicketNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "conversations" ADD COLUMN "ticketNumber" INTEGER;

-- Backfill: number each Workspace's existing Conversations 1..n in creation
-- order (id breaks ties deterministically), then point the counter past them.
UPDATE "conversations" AS c
SET "ticketNumber" = numbered.n
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", "id") AS n
    FROM "conversations"
) AS numbered
WHERE c."id" = numbered."id";

UPDATE "workspaces" AS w
SET "nextTicketNumber" = counts.n + 1
FROM (
    SELECT "workspaceId", COUNT(*) AS n FROM "conversations" GROUP BY "workspaceId"
) AS counts
WHERE w."id" = counts."workspaceId";

ALTER TABLE "conversations" ALTER COLUMN "ticketNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspaceId_ticketNumber_key" ON "conversations"("workspaceId", "ticketNumber");
