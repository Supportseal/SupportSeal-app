-- Free plan daily grace reminders (decided 2026-10-28): one row per
-- Workspace, period and grace day is the dedupe key and audit record.
ALTER TYPE "UsageNotificationLevel" ADD VALUE IF NOT EXISTS 'GRACE_REMINDER';

ALTER TABLE "usage_notifications" ADD COLUMN "graceDay" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "usage_notifications_workspaceId_period_level_key";
CREATE UNIQUE INDEX "usage_notifications_workspaceId_period_level_graceDay_key" ON "usage_notifications"("workspaceId", "period", "level", "graceDay");

-- Free plan pause, kept until the Workspace pays.
ALTER TABLE "workspaces" ADD COLUMN "freePlanPausedAt" TIMESTAMP(3);
-- Last paid-to-Free downgrade: the Free grace window never starts earlier.
ALTER TABLE "workspaces" ADD COLUMN "freePlanSince" TIMESTAMP(3);

-- Period usage counts run on every widget request for Free Workspaces.
CREATE INDEX "conversations_workspaceId_createdAt_idx" ON "conversations"("workspaceId", "createdAt");
