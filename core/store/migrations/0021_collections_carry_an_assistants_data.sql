CREATE TABLE "collection_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"key_value" text NOT NULL,
	"values" jsonb NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"embedding" vector(1024),
	"created_by_user_ref" text,
	"origin_chat_ref" text,
	"source_document_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"assistant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"fill_instruction" text DEFAULT '' NOT NULL,
	"presentation_instruction" text DEFAULT '' NOT NULL,
	"columns" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_visibility_check" CHECK ("collections"."visibility" in ('private', 'shared'))
);
--> statement-breakpoint
ALTER TABLE "collection_rows" ADD CONSTRAINT "collection_rows_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_rows_key_idx" ON "collection_rows" USING btree ("collection_id","key_value");--> statement-breakpoint
CREATE INDEX "collection_rows_complete_idx" ON "collection_rows" USING btree ("collection_id","complete");--> statement-breakpoint
CREATE INDEX "collection_rows_embedding_idx" ON "collection_rows" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "collections_assistant_idx" ON "collections" USING btree ("assistant_id");