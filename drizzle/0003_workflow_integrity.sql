-- Tenant-safe composite references for workflow execution records.
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_fk"
  FOREIGN KEY ("org_id", "workflow_id") REFERENCES "workflows" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_run_fk"
  FOREIGN KEY ("org_id", "run_id") REFERENCES "workflow_runs" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
-- A step succeeds at most once per run: retries resume after the last success.
CREATE UNIQUE INDEX "workflow_run_steps_success_once" ON "workflow_run_steps" ("run_id", "step_index")
  WHERE "status" = 'SUCCEEDED';
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_finished_consistency" CHECK (
  ("status" IN ('SUCCEEDED', 'FAILED')) = ("finished_at" IS NOT NULL)
);
