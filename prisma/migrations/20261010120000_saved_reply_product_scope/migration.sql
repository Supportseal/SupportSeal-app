-- Saved replies can be scoped to one Product (issue #139). Existing rows keep
-- a NULL productId, i.e. they stay Workspace-wide.
ALTER TABLE "saved_replies" ADD COLUMN "productId" TEXT;

-- CreateIndex
CREATE INDEX "saved_replies_workspaceId_productId_idx" ON "saved_replies"("workspaceId", "productId");

-- AddForeignKey
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
