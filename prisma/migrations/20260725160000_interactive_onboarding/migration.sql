-- Interactive onboarding: jobs gain a type, and a state for "holding a live
-- device, waiting for a person".

-- New enums -------------------------------------------------------------------

CREATE TYPE "JobType" AS ENUM ('PUBLISH_VIDEO', 'INTERACTIVE_ONBOARDING');

CREATE TYPE "SessionState" AS ENUM ('NONE', 'ONBOARDING', 'VERIFIED', 'EXPIRED');

-- JobStatus gains AWAITING_HUMAN. Recreated rather than extended for the same
-- reason as the Platform migration: Postgres refuses to use a value added by
-- ALTER TYPE ... ADD VALUE inside the transaction that added it, and Prisma
-- wraps each migration in one.
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";

CREATE TYPE "JobStatus" AS ENUM (
  'QUEUED',
  'SCHEDULED',
  'PROCESSING',
  'AWAITING_HUMAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DEAD'
);

ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "jobs"
  ALTER COLUMN "status" TYPE "JobStatus" USING ("status"::text::"JobStatus");

ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

DROP TYPE "JobStatus_old";

-- Accounts --------------------------------------------------------------------

ALTER TABLE "accounts"
  ADD COLUMN "sessionState" "SessionState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "sessionVerifiedAt" TIMESTAMP(3);

-- Jobs ------------------------------------------------------------------------

ALTER TABLE "jobs"
  ADD COLUMN "type" "JobType" NOT NULL DEFAULT 'PUBLISH_VIDEO',
  ADD COLUMN "deviceEndpoint" JSONB,
  ADD COLUMN "awaitingSince" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "humanConfirmedAt" TIMESTAMP(3);

-- An onboarding job has no media and no text. Existing rows are all publish
-- jobs and keep their values, so nothing is lost by relaxing the constraint.
ALTER TABLE "jobs" ALTER COLUMN "videoId" DROP NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "caption" DROP NOT NULL;

CREATE INDEX "jobs_status_expiresAt_idx" ON "jobs"("status", "expiresAt");
