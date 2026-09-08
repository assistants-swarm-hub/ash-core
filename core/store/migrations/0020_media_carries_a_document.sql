ALTER TABLE "source_media" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "source_media" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "web_media" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "web_media" ADD COLUMN "size_bytes" integer;