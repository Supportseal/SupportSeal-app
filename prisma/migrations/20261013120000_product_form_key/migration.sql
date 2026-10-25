-- Keyed contact-form endpoint (issue #154): a per-Product public form key
-- (`fk_…`) that server-side contact-form handlers present to
-- POST /api/widget/form — no cookie or Origin dependency, unlike the widget
-- key (FR-CHAT-01 origin gate). The endpoint validates the key server-side.
--
-- Nullable like `inboundEmail` (issue #45 precedent): Products created
-- before this column have no key until an Admin generates one from the
-- Product's Developer tab; new Products get one at creation. Postgres
-- unique indexes ignore NULLs, so legacy rows coexist with the constraint.
ALTER TABLE "products" ADD COLUMN "formPublicKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "products_formPublicKey_key" ON "products"("formPublicKey");
