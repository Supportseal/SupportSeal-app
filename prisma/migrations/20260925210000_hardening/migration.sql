-- AlterTable
ALTER TABLE "chat_visitors" ADD COLUMN "originHostname" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_key" ON "memberships"("userId");
