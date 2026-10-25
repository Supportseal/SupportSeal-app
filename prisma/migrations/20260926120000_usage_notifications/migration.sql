-- CreateEnum
CREATE TYPE "UsageNotificationLevel" AS ENUM ('APPROACHING', 'EXCEEDED');

-- CreateTable
CREATE TABLE "usage_notifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "level" "UsageNotificationLevel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_notifications_workspaceId_period_level_key" ON "usage_notifications"("workspaceId", "period", "level");

-- AddForeignKey
ALTER TABLE "usage_notifications" ADD CONSTRAINT "usage_notifications_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
