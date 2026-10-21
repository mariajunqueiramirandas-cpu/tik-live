CREATE TABLE "bridge_device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_lookup" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_device_token_lookup_unique" UNIQUE("token_lookup")
);
--> statement-breakpoint
CREATE TABLE "bridge_pairing" (
	"code_lookup" text PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_device" ADD CONSTRAINT "bridge_device_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_pairing" ADD CONSTRAINT "bridge_pairing_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_device_channel_idx" ON "bridge_device" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "bridge_pairing_expires_idx" ON "bridge_pairing" USING btree ("expires_at");