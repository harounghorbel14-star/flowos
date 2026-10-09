CREATE TYPE "public"."document_category" AS ENUM('CONTRACT', 'POLICY', 'IDENTITY', 'CERTIFICATE', 'INVOICE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."document_visibility" AS ENUM('ORG', 'RESTRICTED');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'DOCUMENT_EXPIRING';--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "document_category" DEFAULT 'OTHER' NOT NULL,
	"visibility" "document_visibility" DEFAULT 'ORG' NOT NULL,
	"employee_id" uuid,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"expires_on" date,
	"expiry_notified_at" timestamp with time zone,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_storage_key" ON "documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_org_expiry_idx" ON "documents" USING btree ("org_id","expires_on");--> statement-breakpoint
CREATE INDEX "documents_org_employee_idx" ON "documents" USING btree ("org_id","employee_id");