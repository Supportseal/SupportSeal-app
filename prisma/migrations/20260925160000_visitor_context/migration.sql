-- AlterTable
ALTER TABLE "chat_visitors" ADD COLUMN "externalUserId" TEXT;

-- AddForeignKey
ALTER TABLE "chat_visitors" ADD CONSTRAINT "chat_visitors_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
