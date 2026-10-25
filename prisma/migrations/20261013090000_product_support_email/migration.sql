-- AlterTable
-- Optional customer-facing support address per Product (display + mail-loop
-- guard only). Nullable: zero-config Products simply have none.
ALTER TABLE "products" ADD COLUMN "supportEmail" TEXT;
