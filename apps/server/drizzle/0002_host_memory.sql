CREATE TABLE "host_memory" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_memory" ADD CONSTRAINT "host_memory_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;