-- Verified widget identity (issue #20): a per-Product server secret the
-- host app uses to sign identify() user ids (HMAC-SHA256), and the
-- per-visitor proof stamp the inbox badge reads. Both nullable and
-- additive: new Products get a secret at create, existing ones allocate on
-- demand from the Developer tab (the formPublicKey pattern), and a null
-- verifiedAt simply means "unverified".
ALTER TABLE "products" ADD COLUMN "identitySecret" TEXT;

ALTER TABLE "chat_visitors" ADD COLUMN "identityVerifiedAt" TIMESTAMP(3);
