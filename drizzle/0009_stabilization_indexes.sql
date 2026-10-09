-- Existing databases may already hold several open invitations for one email (concurrent invites);
-- keep the newest and revoke the rest so the unique index below can be built.
UPDATE "invitations" i SET "revoked_at" = now()
 WHERE i."accepted_at" IS NULL AND i."revoked_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "invitations" n
      WHERE n."org_id" = i."org_id" AND n."email" = i."email"
        AND n."accepted_at" IS NULL AND n."revoked_at" IS NULL
        AND (n."created_at", n."id") > (i."created_at", i."id"));--> statement-breakpoint
CREATE INDEX "approvals_org_created_idx" ON "approval_requests" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_expiry_pending_idx" ON "documents" USING btree ("expires_on") WHERE "documents"."expiry_notified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_email_key" ON "invitations" USING btree ("org_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");