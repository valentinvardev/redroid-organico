-- Adds SPORT_REELS, the app under test, and makes it the default platform.
--
-- The enum is recreated rather than extended with `ALTER TYPE ... ADD VALUE`:
-- Postgres refuses to use a value added by ADD VALUE inside the same
-- transaction, and Prisma runs each migration in one. Setting the new default
-- here would therefore fail. Recreating the type does both in one atomic step.

ALTER TYPE "Platform" RENAME TO "Platform_old";

CREATE TYPE "Platform" AS ENUM ('SPORT_REELS', 'TIKTOK');

ALTER TABLE "accounts" ALTER COLUMN "platform" DROP DEFAULT;

ALTER TABLE "accounts"
  ALTER COLUMN "platform" TYPE "Platform" USING ("platform"::text::"Platform");

ALTER TABLE "accounts" ALTER COLUMN "platform" SET DEFAULT 'SPORT_REELS';

DROP TYPE "Platform_old";
