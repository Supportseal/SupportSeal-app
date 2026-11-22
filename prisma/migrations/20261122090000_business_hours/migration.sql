-- Per-member business hours and the automatic Live/Away mode that follows
-- them. Existing Workspaces keep their manual LIVE/AWAY value.
ALTER TYPE "WorkspaceAvailability" ADD VALUE 'AUTO';

ALTER TABLE "memberships" ADD COLUMN "businessHoursTimeZone" TEXT;
ALTER TABLE "memberships" ADD COLUMN "businessHours" JSONB;
