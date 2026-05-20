-- Initial OSS schema. Five tables, no billing, no user management.
--
--   github_installations       GitHub App installations (webhook-driven).
--   installation_repositories  Repos visible to each installation.
--   webhook_deliveries         Idempotency log for inbound GitHub webhooks.
--   video_jobs                 One row per PR-to-video request, includes the
--                              full pipeline state and result.
--   api_keys                   API key auth (admin keys + one-time trial keys).
--
-- Order matters: tables with foreign-key references come after their targets.

CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint UNIQUE NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "installation_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_ref" uuid NOT NULL REFERENCES "github_installations"("id"),
	"github_repository_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"is_active" boolean NOT NULL DEFAULT true,
	"permissions_json" jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_installation_repo"
	ON "installation_repositories" ("installation_ref", "github_repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repo_full_name"
	ON "installation_repositories" ("repo_full_name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY,
	"event_type" text NOT NULL,
	"installation_id" bigint,
	"repository_id" bigint,
	"status" text NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone NOT NULL DEFAULT now(),
	"processed_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "video_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'queued',
	"video_url" text,
	"object_key" text,
	"error_code" text,
	"error_message" text,
	"script_json" jsonb,
	"tts_audio_json" jsonb,
	"duration_ms" integer,
	"metrics_json" jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"completed_at" timestamp with time zone,
	"installation_ref" uuid REFERENCES "github_installations"("id"),
	"github_installation_id" bigint,
	"github_repository_id" bigint,
	"triggered_via" text NOT NULL DEFAULT 'api',
	"triggered_by" text,
	"delivery_id" text REFERENCES "webhook_deliveries"("delivery_id"),
	"api_key_id" text,
	"status_comment_posted" boolean NOT NULL DEFAULT false,
	"script_only" boolean NOT NULL DEFAULT false,
	"repo_is_private" boolean NOT NULL DEFAULT false,
	"current_stage" text,
	CONSTRAINT "chk_video_jobs_webhook_tenant_fields" CHECK (
		"triggered_via" <> 'github_app_webhook'
		OR ("installation_ref" IS NOT NULL AND "github_installation_id" IS NOT NULL AND "delivery_id" IS NOT NULL)
	)
);
--> statement-breakpoint

-- Tenant-scoped uniqueness: one active job per (installation, repo, PR).
-- Rows with NULL installation_ref (API-triggered) are excluded from this
-- constraint and covered by the API-row partial index below.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_active_job_per_pr_tenant"
	ON "video_jobs" ("installation_ref", "repo_full_name", "pr_number")
	WHERE "installation_ref" IS NOT NULL AND "status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_active_job_per_pr_api"
	ON "video_jobs" ("repo_full_name", "pr_number")
	WHERE "installation_ref" IS NULL AND "status" IN ('queued', 'processing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status" ON "video_jobs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_created" ON "video_jobs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_installation_ref" ON "video_jobs" ("installation_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_delivery_id" ON "video_jobs" ("delivery_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" text UNIQUE NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean NOT NULL DEFAULT false,
	"installation_ref" uuid REFERENCES "github_installations"("id"),
	"scopes" text[] NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"revoked_at" timestamp with time zone,
	"max_uses" integer,
	"uses_count" integer NOT NULL DEFAULT 0,
	"current_job_id" uuid REFERENCES "video_jobs"("id"),
	"label" text,
	"consumed_at" timestamp with time zone
);
