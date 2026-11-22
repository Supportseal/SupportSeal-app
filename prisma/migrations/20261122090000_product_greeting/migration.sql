-- Custom widget greeting (docs/design/branding.md, BQ4). Nullable: existing
-- Products keep the built-in greeting.
ALTER TABLE "products" ADD COLUMN "greeting" TEXT;
