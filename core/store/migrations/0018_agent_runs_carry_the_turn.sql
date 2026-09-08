ALTER TABLE "agent_runs" ADD COLUMN "assistant_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "sender_is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "authority_is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "quiet" boolean DEFAULT false NOT NULL;