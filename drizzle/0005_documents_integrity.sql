ALTER TABLE "documents" ADD CONSTRAINT "documents_employee_fk"
  FOREIGN KEY ("org_id", "employee_id") REFERENCES "employees" ("org_id", "id")
  ON DELETE SET NULL ("employee_id");
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_size_limit" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760);
