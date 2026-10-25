-- CreateIndex
-- Uniqueness of generated inbound addresses is enforced at persistence time
-- (issue #45): the allocation loop is a fast path, this index is the
-- invariant. NULLs stay distinct, so legacy Products without an address
-- (created before generation) are unaffected.
CREATE UNIQUE INDEX "products_inboundEmail_key" ON "products"("inboundEmail");
