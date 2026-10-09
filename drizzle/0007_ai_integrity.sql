ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_fk"
  FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ai_conversations" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_conversation_fk"
  FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ai_conversations" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_conversation_fk"
  FOREIGN KEY ("org_id", "conversation_id") REFERENCES "ai_conversations" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_decision_consistency" CHECK (
  ("status" = 'PROPOSED') = ("decided_at" IS NULL)
);
--> statement-breakpoint
-- The transcript is append-only: edits would invalidate replayed thinking blocks.
CREATE OR REPLACE FUNCTION flowos_ai_messages_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ai_messages is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ai_messages_no_update BEFORE UPDATE ON "ai_messages"
  FOR EACH ROW EXECUTE FUNCTION flowos_ai_messages_immutable();
