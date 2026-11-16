-- Cover GET /api/v1/contacts' pagination pattern (workspaceId equality,
-- createdAt/id ordering) without an in-memory sort of the Workspace's whole
-- Contact set; the sibling list models (Conversation, Message, ApiAuditLog)
-- carry the same composite index.
CREATE INDEX "contacts_workspaceId_createdAt_idx" ON "contacts"("workspaceId", "createdAt");
