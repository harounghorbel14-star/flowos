-- Tenant integrity: composite foreign keys on (org_id, <ref>) make it
-- impossible at the database level for a row to reference another
-- organization's record, even if application validation were bypassed.
-- PostgreSQL 15+ column-list SET NULL keeps org_id intact on delete.

ALTER TABLE "employees" ADD CONSTRAINT "employees_department_fk"
  FOREIGN KEY ("org_id", "department_id") REFERENCES "departments" ("org_id", "id")
  ON DELETE SET NULL ("department_id");
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_fk"
  FOREIGN KEY ("org_id", "manager_id") REFERENCES "employees" ("org_id", "id")
  ON DELETE SET NULL ("manager_id");
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_member_fk"
  FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships" ("org_id", "user_id")
  ON DELETE SET NULL ("user_id");
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_not_own_manager" CHECK ("manager_id" IS NULL OR "manager_id" <> "id");
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_fk"
  FOREIGN KEY ("org_id", "owner_employee_id") REFERENCES "employees" ("org_id", "id")
  ON DELETE SET NULL ("owner_employee_id");
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_fk"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "projects" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_employee_fk"
  FOREIGN KEY ("org_id", "employee_id") REFERENCES "employees" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "projects" ("org_id", "id")
  ON DELETE SET NULL ("project_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_fk"
  FOREIGN KEY ("org_id", "assignee_employee_id") REFERENCES "employees" ("org_id", "id")
  ON DELETE SET NULL ("assignee_employee_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_consistency" CHECK (
  ("status" = 'DONE') = ("completed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_fk"
  FOREIGN KEY ("org_id", "task_id") REFERENCES "tasks" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_request_fk"
  FOREIGN KEY ("org_id", "request_id") REFERENCES "approval_requests" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approvals_decision_consistency" CHECK (
  ("status" = 'PENDING') = ("decided_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approvals_not_self" CHECK ("requester_user_id" <> "approver_user_id");
--> statement-breakpoint

-- Audit log is append-only. Any UPDATE or DELETE raises, regardless of caller.
CREATE OR REPLACE FUNCTION flowos_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION flowos_audit_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION flowos_audit_immutable();
