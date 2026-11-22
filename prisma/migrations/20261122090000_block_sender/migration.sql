-- Spam control: block a sender. Nullable timestamps, no backfill: every
-- existing Contact and visitor stays unblocked.
ALTER TABLE "contacts" ADD COLUMN "blockedAt" TIMESTAMP(3);
ALTER TABLE "chat_visitors" ADD COLUMN "blockedAt" TIMESTAMP(3);
-- Which Contact's block it is, so an unblock reaches visitors whose
-- Conversation was deleted in between (conversationId is SET NULL then).
ALTER TABLE "chat_visitors" ADD COLUMN "blockedContactId" TEXT;
