import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  boolean,
  bigint,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── github_installations ──────────────────────────────────────────────────────

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: bigint("installation_id", { mode: "number" }).unique().notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // 'User' | 'Organization'
    status: text("status").notNull().default("active"), // 'active' | 'suspended' | 'deleted'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// ── installation_repositories ─────────────────────────────────────────────────

export const installationRepositories = pgTable(
  "installation_repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationRef: uuid("installation_ref")
      .references(() => githubInstallations.id)
      .notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }).notNull(),
    repoFullName: text("repo_full_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    permissionsJson: jsonb("permissions_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_installation_repo").on(t.installationRef, t.githubRepositoryId),
    index("idx_repo_full_name").on(t.repoFullName),
  ],
);

// ── api_keys ──────────────────────────────────────────────────────────────────

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  keyId: text("key_id").unique().notNull(),    // public identifier (prefix of raw key)
  keyHash: text("key_hash").notNull(),          // Argon2id hash of peppered secret
  name: text("name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  installationRef: uuid("installation_ref").references(() => githubInstallations.id), // NULL = admin key
  scopes: text("scopes").array().notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'in_use' | 'consumed' | 'revoked'
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // One-time key fields
  maxUses: integer("max_uses"),                 // NULL = unlimited (regular key), 1 = one-time key
  usesCount: integer("uses_count").notNull().default(0),
  currentJobId: uuid("current_job_id").references(() => videoJobs.id), // non-null when status = 'in_use'
  label: text("label"),                         // optional human-readable recipient identifier
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

// ── webhook_deliveries ────────────────────────────────────────────────────────

export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(), // X-GitHub-Delivery header
  eventType: text("event_type").notNull(),
  installationId: bigint("installation_id", { mode: "number" }),
  repositoryId: bigint("repository_id", { mode: "number" }),
  status: text("status").notNull(), // 'received' | 'processed' | 'skipped' | 'failed'
  reason: text("reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

// ── video_jobs ────────────────────────────────────────────────────────────────

export const videoJobs = pgTable(
  "video_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    status: text("status").notNull().default("queued"),
    videoUrl: text("video_url"),
    objectKey: text("object_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    scriptJson: jsonb("script_json"),
    ttsAudioJson: jsonb("tts_audio_json"),
    durationMs: integer("duration_ms"),
    metricsJson: jsonb("metrics_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Tenant fields — nullable for backward compat with API-triggered jobs
    installationRef: uuid("installation_ref").references(() => githubInstallations.id),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    triggeredVia: text("triggered_via").notNull().default("api"), // 'github_app_webhook' | 'github_action' | 'api'
    triggeredBy: text("triggered_by"),
    deliveryId: text("delivery_id").references(() => webhookDeliveries.deliveryId),
    apiKeyId: text("api_key_id"),  // keyId of the one-time key used to create this job (null for admin/webhook jobs)
    statusCommentPosted: boolean("status_comment_posted").notNull().default(false),
    scriptOnly: boolean("script_only").notNull().default(false),
    repoIsPrivate: boolean("repo_is_private").notNull().default(false),
    currentStage: text("current_stage"),
  },
  (table) => [
    // Tenant-scoped uniqueness: one active job per (installation, repo, PR).
    // Rows with NULL installation_ref (API-triggered) are excluded from this constraint.
    uniqueIndex("idx_active_job_per_pr_tenant")
      .on(table.installationRef, table.repoFullName, table.prNumber)
      .where(sql`installation_ref IS NOT NULL AND status IN ('queued', 'processing')`),
    // API-triggered jobs (installation_ref IS NULL) still need race-safe uniqueness.
    uniqueIndex("idx_active_job_per_pr_api")
      .on(table.repoFullName, table.prNumber)
      .where(sql`installation_ref IS NULL AND status IN ('queued', 'processing')`),
    // Enforce tenant fields for webhook-triggered rows while allowing API rows to stay null-scoped.
    check(
      "chk_video_jobs_webhook_tenant_fields",
      sql`triggered_via <> 'github_app_webhook' OR (installation_ref IS NOT NULL AND github_installation_id IS NOT NULL AND delivery_id IS NOT NULL)`,
    ),
    index("idx_jobs_status").on(table.status),
    index("idx_jobs_created").on(table.createdAt),
    index("idx_jobs_installation_ref").on(table.installationRef),
    index("idx_jobs_delivery_id").on(table.deliveryId),
  ],
);
