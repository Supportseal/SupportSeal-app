-- AlterTable: store invite tokens hashed, never in plain form.
ALTER TABLE "invites" RENAME COLUMN "token" TO "tokenHash";
