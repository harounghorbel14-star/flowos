CREATE TYPE "public"."ai_memory_scope" AS ENUM('PREFERENCE', 'ORG_KNOWLEDGE', 'OUTCOME');--> statement-breakpoint
CREATE TYPE "public"."ai_run_status" AS ENUM('RUNNING', 'COMPLETED', 'PARTIAL', 'AWAITING_CONFIRMATION', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ai_step_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'AWAITING_CONFIRMATION', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"scope" "ai_memory_scope" NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" jsonb,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"tool" text NOT NULL,
	"purpose" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" "ai_step_status" DEFAULT 'PENDING' NOT NULL,
	"planned" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result_summary" text,
	"result" jsonb,
	"error" text,
	"action_id" uuid,
	"verified" boolean,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"model" text,
	"intent" text,
	"objective" text NOT NULL,
	"status" "ai_run_status" DEFAULT 'RUNNING' NOT NULL,
	"summary" text,
	"report" jsonb,
	"error" text,
	"model_requests" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"latency_ms" integer
);
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "step_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "precondition" jsonb;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD COLUMN "verified" boolean;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_memories_scope_idx" ON "ai_memories" USING btree ("org_id","scope","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_run_steps_position_key" ON "ai_run_steps" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_org_id_key" ON "ai_runs" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "ai_runs_conversation_idx" ON "ai_runs" USING btree ("org_id","conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "ai_runs_user_idx" ON "ai_runs" USING btree ("org_id","user_id","started_at");