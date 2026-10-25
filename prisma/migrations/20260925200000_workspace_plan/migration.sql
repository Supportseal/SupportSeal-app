-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "plan" "WorkspacePlan" NOT NULL DEFAULT 'FREE';
