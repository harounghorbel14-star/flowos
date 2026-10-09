CREATE TABLE "metric_snapshots" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"open_tasks" integer NOT NULL,
	"overdue_tasks" integer NOT NULL,
	"blocked_tasks" integer NOT NULL,
	"pending_approvals" integer NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_snapshots_org_id_day_pk" PRIMARY KEY("org_id","day")
);
--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;