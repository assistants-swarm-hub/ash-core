ALTER TABLE "browser_agent_runs" RENAME TO "agent_runs";--> statement-breakpoint
ALTER TABLE "browser_run_screenshots" RENAME TO "agent_run_screenshots";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME CONSTRAINT "browser_agent_runs_pkey" TO "agent_runs_pkey";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME CONSTRAINT "browser_agent_runs_status_check" TO "agent_runs_status_check";--> statement-breakpoint
ALTER INDEX "browser_agent_runs_status_idx" RENAME TO "agent_runs_status_idx";--> statement-breakpoint
ALTER INDEX "browser_agent_runs_chat_idx" RENAME TO "agent_runs_chat_idx";--> statement-breakpoint
ALTER TABLE "agent_run_screenshots" RENAME CONSTRAINT "browser_run_screenshots_run_id_seq_pk" TO "agent_run_screenshots_run_id_seq_pk";--> statement-breakpoint
ALTER TABLE "agent_run_screenshots" RENAME CONSTRAINT "browser_run_screenshots_run_id_browser_agent_runs_id_fk" TO "agent_run_screenshots_run_id_agent_runs_id_fk";--> statement-breakpoint
ALTER TABLE "settings" RENAME COLUMN "browser_backend_id" TO "agent_backend_id";--> statement-breakpoint
ALTER TABLE "settings" RENAME COLUMN "browser_model" TO "agent_model";--> statement-breakpoint
ALTER TABLE "settings" RENAME CONSTRAINT "settings_browser_backend_id_backends_id_fk" TO "settings_agent_backend_id_backends_id_fk";
