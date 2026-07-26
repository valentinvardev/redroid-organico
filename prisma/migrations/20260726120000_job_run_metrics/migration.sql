-- Load-test bookkeeping on the job: which flow profile ran, which egress it
-- used, and the per-step timing the report aggregates. All nullable and
-- additive — an ordinary job leaves them null.

ALTER TABLE "jobs"
  ADD COLUMN "runProfile"  TEXT,
  ADD COLUMN "regionLabel" TEXT,
  ADD COLUMN "metrics"     JSONB;

CREATE INDEX "jobs_regionLabel_runProfile_idx" ON "jobs"("regionLabel", "runProfile");
