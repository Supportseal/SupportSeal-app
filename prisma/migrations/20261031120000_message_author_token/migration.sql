-- Agent-first Workspace API, slice 1d (docs/agent-api-plan.md): a reply or
-- note written through the API records the token that wrote it.
ALTER TABLE "messages" ADD COLUMN "authorTokenId" TEXT;

ALTER TABLE "messages" ADD CONSTRAINT "messages_authorTokenId_fkey" FOREIGN KEY ("authorTokenId") REFERENCES "api_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
