-- Runs belong to a conversation in the same organization; steps to a run in the same organization.
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_fk"
  FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ai_conversations" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_run_steps" ADD CONSTRAINT "ai_run_steps_run_fk"
  FOREIGN KEY ("org_id", "run_id") REFERENCES "ai_runs" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_run_steps" ADD CONSTRAINT "ai_run_steps_bounds" CHECK (
  "position" >= 0 AND "position" < 64 AND "attempts" >= 0 AND "attempts" <= 5
);
--> statement-breakpoint
-- Memory ownership by scope: personal entries have an owner, organization knowledge has none.
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_scope_owner" CHECK (
  ("scope" = 'ORG_KNOWLEDGE') = ("user_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_source_by_scope" CHECK (
  ("scope" = 'OUTCOME') = ("source" = 'engine')
);
--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_content_length" CHECK (
  char_length("content") BETWEEN 1 AND 500
);
