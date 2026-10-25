-- AlterTable
ALTER TABLE "products" ADD COLUMN "diagnosticsEnabledAt" TIMESTAMP(3),
ADD COLUMN "diagnosticsEnabledById" TEXT;

-- CreateTable
CREATE TABLE "diagnostic_snapshots" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "environment" JSONB NOT NULL,
    "events" JSONB NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "networkFailureCount" INTEGER NOT NULL,
    "droppedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_snapshots_messageId_key" ON "diagnostic_snapshots"("messageId");
CREATE INDEX "diagnostic_snapshots_workspaceId_conversationId_idx" ON "diagnostic_snapshots"("workspaceId", "conversationId");
CREATE INDEX "diagnostic_snapshots_productId_expiresAt_idx" ON "diagnostic_snapshots"("productId", "expiresAt");

-- AddForeignKey
ALTER TABLE "diagnostic_snapshots" ADD CONSTRAINT "diagnostic_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "diagnostic_snapshots" ADD CONSTRAINT "diagnostic_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "diagnostic_snapshots" ADD CONSTRAINT "diagnostic_snapshots_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "diagnostic_snapshots" ADD CONSTRAINT "diagnostic_snapshots_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_diagnosticsEnabledById_fkey" FOREIGN KEY ("diagnosticsEnabledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
