-- CreateEnum
CREATE TYPE "WorkspaceAvailability" AS ENUM ('LIVE', 'AWAY');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "availability" "WorkspaceAvailability" NOT NULL DEFAULT 'LIVE';
