-- VERIFYING: the operator confirmed and the worker is running the verification
-- flow. Previously this was inferred from AWAITING_HUMAN + humanConfirmedAt,
-- which left a job that died mid-verification indistinguishable from one that
-- died waiting for a person.
--
-- Type recreated rather than extended, for the same reason as the earlier enum
-- migrations: Postgres refuses to use a value added by ALTER TYPE ... ADD VALUE
-- inside the transaction that added it, and Prisma wraps each migration in one.

ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";

CREATE TYPE "JobStatus" AS ENUM (
  'QUEUED',
  'SCHEDULED',
  'PROCESSING',
  'AWAITING_HUMAN',
  'VERIFYING',
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
