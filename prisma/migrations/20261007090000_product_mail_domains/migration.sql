-- CreateTable
CREATE TABLE "product_mail_domains" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_mail_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_mail_domains_productId_key" ON "product_mail_domains"("productId");

-- CreateIndex
CREATE INDEX "product_mail_domains_domain_idx" ON "product_mail_domains"("domain");

-- One *verified* domain globally: backstop for the check-then-update race in
-- verifyMailDomain (two Products concurrently verifying the same domain).
-- Pending claims stay unrestricted. Prisma's DSL cannot express partial
-- indexes, so this lives here only (noted on the model in schema.prisma);
-- do not "clean it up" in a future migrate diff.
CREATE UNIQUE INDEX "product_mail_domains_verified_domain_key" ON "product_mail_domains"("domain") WHERE "verifiedAt" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "product_mail_domains" ADD CONSTRAINT "product_mail_domains_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
