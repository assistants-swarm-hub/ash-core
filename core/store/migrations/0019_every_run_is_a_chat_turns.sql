-- Every run is a chat turn's (user decision, 2026-09-08): the dashboard-started,
-- browser-only run is gone, and so are its rows and the pre-binding rows of the
-- retired browser agent (history of a feature that no longer exists).
DELETE FROM "agent_runs" WHERE "chat_ref" IS NULL OR "assistant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "chat_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "assistant_id" SET NOT NULL;