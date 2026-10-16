CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tiktok_username" text,
	"source" text DEFAULT 'simulator' NOT NULL,
	"persona" jsonb NOT NULL,
	"voice" jsonb NOT NULL,
	"safety" jsonb NOT NULL,
	"broadcast" jsonb NOT NULL,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"stage_key_lookup" text NOT NULL,
	"stage_key_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_stage_key_lookup_unique" UNIQUE("stage_key_lookup")
);
--> statement-breakpoint
CREATE TABLE "session_sample" (
	"session_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"viewers" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"diamonds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_sample_session_id_minute_pk" PRIMARY KEY("session_id","minute")
);
--> statement-breakpoint
CREATE TABLE "stream_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"source" text NOT NULL,
	"peak_viewers" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"diamonds" integer DEFAULT 0 NOT NULL,
	"gifts" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"follows" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"joins" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"spoken_lines" integer DEFAULT 0 NOT NULL,
	"blocked_lines" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"tts_characters" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"provider" text DEFAULT 'mercadopago' NOT NULL,
	"provider_subscription_id" text,
	"amount" double precision,
	"currency" text,
	"next_payment_at" timestamp with time zone,
	"last_payment_at" timestamp with time zone,
	"last_payment_status" text,
	"grace_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"day" date NOT NULL,
	"llm_requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"moderation_requests" integer DEFAULT 0 NOT NULL,
	"tts_characters" integer DEFAULT 0 NOT NULL,
	"runtime_seconds" integer DEFAULT 0 NOT NULL,
	"broadcast_seconds" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_user_id_channel_id_day_pk" PRIMARY KEY("user_id","channel_id","day")
);
--> statement-breakpoint
CREATE TABLE "utterance" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"emotion" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"turn_kind" text
);
--> statement-breakpoint
CREATE TABLE "viewer" (
	"channel_id" uuid NOT NULL,
	"platform_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"nickname" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"visits" integer DEFAULT 1 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"diamonds" integer DEFAULT 0 NOT NULL,
	"gifts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"follows" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"recent_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "viewer_channel_id_platform_user_id_pk" PRIMARY KEY("channel_id","platform_user_id")
);
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_sample" ADD CONSTRAINT "session_sample_session_id_stream_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."stream_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_session" ADD CONSTRAINT "stream_session_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterance" ADD CONSTRAINT "utterance_session_id_stream_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."stream_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer" ADD CONSTRAINT "viewer_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channel_owner_idx" ON "channel" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "channel_desired_state_idx" ON "channel" USING btree ("desired_state");--> statement-breakpoint
CREATE INDEX "stream_session_channel_idx" ON "stream_session" USING btree ("channel_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "utterance_session_idx" ON "utterance" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "utterance_channel_at_idx" ON "utterance" USING btree ("channel_id","at");--> statement-breakpoint
CREATE INDEX "viewer_top_supporters_idx" ON "viewer" USING btree ("channel_id","diamonds" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "viewer_last_seen_idx" ON "viewer" USING btree ("channel_id","last_seen_at" DESC NULLS LAST);