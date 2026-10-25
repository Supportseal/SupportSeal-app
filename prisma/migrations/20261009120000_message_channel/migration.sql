-- AlterTable
-- Per-message channel (issue #128): the channel each message was actually
-- written through — CHAT for widget/visitor messages, EMAIL for inbound
-- customer mail and agent replies the routing decision sends by email.
-- Nullable on purpose: rows written before this column, internal notes
-- (never sent anywhere) and agent replies whose routing decision has not
-- run are unknown and stay NULL instead of being backfilled with a guess.
ALTER TABLE "messages" ADD COLUMN "channel" "ConversationChannel";
