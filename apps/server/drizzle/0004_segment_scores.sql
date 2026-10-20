CREATE TABLE "segment_scores" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "segment_scores" ADD CONSTRAINT "segment_scores_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;