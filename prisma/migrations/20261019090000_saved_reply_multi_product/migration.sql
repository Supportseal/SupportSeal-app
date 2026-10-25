-- Saved replies: many-Product availability (issue #200). A reply with no
-- rows in saved_reply_products is Workspace-wide ("All products").
CREATE TABLE "saved_reply_products" (
  "savedReplyId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,

  CONSTRAINT "saved_reply_products_pkey" PRIMARY KEY ("savedReplyId","productId")
);

-- CreateIndex
CREATE INDEX "saved_reply_products_productId_idx" ON "saved_reply_products"("productId");

-- AddForeignKey
ALTER TABLE "saved_reply_products" ADD CONSTRAINT "saved_reply_products_savedReplyId_fkey" FOREIGN KEY ("savedReplyId") REFERENCES "saved_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reply_products" ADD CONSTRAINT "saved_reply_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing single-Product scopes become one availability row each;
-- Workspace-wide rows (NULL productId) keep meaning "All products" = no rows.
INSERT INTO "saved_reply_products" ("savedReplyId", "productId")
SELECT "id", "productId" FROM "saved_replies" WHERE "productId" IS NOT NULL;

DROP INDEX "saved_replies_workspaceId_productId_idx";

-- AlterTable
ALTER TABLE "saved_replies" DROP CONSTRAINT "saved_replies_productId_fkey";

-- AlterTable
ALTER TABLE "saved_replies" DROP COLUMN "productId";
