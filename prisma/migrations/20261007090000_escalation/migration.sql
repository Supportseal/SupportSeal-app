-- AlterTable
ALTER TABLE "products" ADD COLUMN     "escalationAfterMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "escalationEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "conversations_productId_createdAt_idx" ON "conversations"("productId", "createdAt");
