-- Alter the default status for zap_runs
ALTER TABLE "zap_runs" ALTER COLUMN "status" SET DEFAULT 'queued';

-- Drop the old constraint (Postgres auto-names it based on table and column)
ALTER TABLE "zap_runs" DROP CONSTRAINT IF EXISTS "zap_runs_status_check";

-- Add the new constraint with 'queued'
ALTER TABLE "zap_runs" ADD CONSTRAINT "zap_runs_status_check" 
  CHECK ("status" IN ('queued', 'in_progress', 'completed', 'failed', 'filtered'));
