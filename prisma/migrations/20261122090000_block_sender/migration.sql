-- Spam control: block a sender. Nullable timestamps, no backfill: every
-- existing Contact and visitor stays unblocked.
ALTER TABLE "contacts" ADD COLUMN "blockedAt" TIMESTAMP(3);
ALTER TABLE "chat_visitors" ADD COLUMN "blockedAt" TIMESTAMP(3);
