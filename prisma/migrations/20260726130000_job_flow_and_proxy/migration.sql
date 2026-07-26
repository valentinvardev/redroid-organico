-- Per-job flow selection and per-job egress override.
--   flowType: which named flow the run drives ("upload", "login", "scroll").
--             Null keeps the account's default flow, so existing jobs are
--             unaffected.
--   proxyId:  a per-run egress that overrides the account's own proxy, so one
--             account can be pointed at different regions across a batch.
-- Both nullable and additive; an ordinary publish leaves them null.

ALTER TABLE "jobs"
  ADD COLUMN "flowType" TEXT,
  ADD COLUMN "proxyId"  TEXT;

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_proxyId_fkey"
  FOREIGN KEY ("proxyId") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "jobs_proxyId_idx" ON "jobs"("proxyId");
