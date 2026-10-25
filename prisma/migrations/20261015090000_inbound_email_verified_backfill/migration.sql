-- Issue #169: inbound routing now accepts only verified product addresses.
-- Until now `inboundEmail` was only ever platform-generated (issue #45) and
-- `inboundEmailVerified` was never set, so every existing address would stop
-- routing. Generated addresses need no customer proof: stamp them verified.
UPDATE "products"
SET "inboundEmailVerified" = CURRENT_TIMESTAMP
WHERE "inboundEmail" IS NOT NULL AND "inboundEmailVerified" IS NULL;
