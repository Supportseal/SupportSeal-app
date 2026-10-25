-- CreateTable
CREATE TABLE "chat_visitors" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "conversationId" TEXT,
    "createdConversationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "devContext" JSONB,

    CONSTRAINT "chat_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_visitors_tokenHash_key" ON "chat_visitors"("tokenHash");

-- CreateIndex
CREATE INDEX "chat_visitors_productId_idx" ON "chat_visitors"("productId");

-- AddForeignKey
ALTER TABLE "chat_visitors" ADD CONSTRAINT "chat_visitors_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
