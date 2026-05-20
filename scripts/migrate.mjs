#!/usr/bin/env node

import crypto from "node:crypto";
import { error as consoleError, log as consoleLog } from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import pg from "pg";

const { Client } = pg;

const MIGRATIONS_DIR = "drizzle";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const TRACKING_TABLE = "public.schema_migrations";
const ADVISORY_LOCK_KEY = "prvod:schema-migrations";

export function validateDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is required. Set DATABASE_URL to a postgresql:// connection string before running migrations.",
    );
  }

  const trimmed = databaseUrl.trim();
  if (!trimmed.startsWith("postgresql://")) {
    throw new Error(
      "DATABASE_URL must start with postgresql://. Refusing to run migrations against an invalid database URL.",
    );
  }

  try {
    new URL(trimmed);
  } catch {
    throw new Error("DATABASE_URL must be a valid postgresql:// URL.");
  }

  return trimmed;
}

export function sortMigrationFilenames(filenames) {
  return filenames
    .filter((filename) => filename.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

export function splitSqlStatements(sql) {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function checksumSql(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

export function planMigrationRecord(filename, checksum, appliedRecord) {
  if (!appliedRecord) {
    return { action: "apply" };
  }

  if (appliedRecord.checksum === checksum) {
    return { action: "skip" };
  }

  return {
    action: "checksum_mismatch",
    message:
      `Migration ${filename} was already applied with checksum ${appliedRecord.checksum}, ` +
      `but the checked-in file now has checksum ${checksum}. Refusing to continue.`,
  };
}

export function decideInitialSchemaMode({
  trackingTableExists,
  existingPublicTableCount,
  baselineRequested,
}) {
  if (trackingTableExists || existingPublicTableCount === 0) {
    return "run";
  }

  return baselineRequested ? "baseline" : "fail_existing_schema";
}

async function readMigrationFiles(migrationsDir) {
  let entries;
  try {
    entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Migration directory not found: ${migrationsDir}`);
    }
    throw error;
  }

  const filenames = sortMigrationFilenames(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  const migrations = [];
  for (const filename of filenames) {
    const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
    migrations.push({
      filename,
      sql,
      checksum: checksumSql(sql),
      statements: splitSqlStatements(sql),
    });
  }

  return migrations;
}

async function trackingTableExists(client) {
  const result = await client.query("SELECT to_regclass($1) AS table_name", [
    TRACKING_TABLE,
  ]);
  return result.rows[0]?.table_name != null;
}

async function countExistingPublicTables(client) {
  const result = await client.query(`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name <> 'schema_migrations'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function createTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigration(client, filename) {
  const result = await client.query(
    "SELECT filename, checksum FROM public.schema_migrations WHERE filename = $1",
    [filename],
  );
  return result.rows[0] ?? null;
}

async function recordMigration(client, migration) {
  await client.query(
    "INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)",
    [migration.filename, migration.checksum],
  );
}

async function baselineMigrations(client, migrations) {
  await client.query("BEGIN");
  try {
    await createTrackingTable(client);
    for (const migration of migrations) {
      await recordMigration(client, migration);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function applyMigration(client, migration) {
  await client.query("BEGIN");
  try {
    for (const statement of migration.statements) {
      await client.query(statement);
    }
    await recordMigration(client, migration);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLog;
  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL);
  const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
  const migrations = await readMigrationFiles(migrationsDir);
  const client = new Client({ connectionString: databaseUrl });
  let locked = false;

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      ADVISORY_LOCK_KEY,
    ]);
    locked = true;

    const hasTrackingTable = await trackingTableExists(client);
    const existingPublicTableCount = hasTrackingTable
      ? 0
      : await countExistingPublicTables(client);
    const initialMode = decideInitialSchemaMode({
      trackingTableExists: hasTrackingTable,
      existingPublicTableCount,
      baselineRequested: env.MIGRATIONS_BASELINE === "1",
    });

    if (initialMode === "fail_existing_schema") {
      throw new Error(
        "Existing public tables were found, but public.schema_migrations does not exist. " +
        "This database may have been managed by drizzle-kit push. To baseline without executing SQL, " +
        "run once with MIGRATIONS_BASELINE=1 node scripts/migrate.mjs. Review the checked-in drizzle/*.sql files before baselining.",
      );
    }

    if (initialMode === "baseline") {
      await baselineMigrations(client, migrations);
      log(`Baselined ${migrations.length} migration file(s) without executing SQL.`);
      return;
    }

    await createTrackingTable(client);

    let applied = 0;
    let skipped = 0;
    for (const migration of migrations) {
      const appliedRecord = await getAppliedMigration(client, migration.filename);
      const plan = planMigrationRecord(
        migration.filename,
        migration.checksum,
        appliedRecord,
      );

      if (plan.action === "skip") {
        skipped += 1;
        continue;
      }

      if (plan.action === "checksum_mismatch") {
        throw new Error(plan.message);
      }

      await applyMigration(client, migration);
      applied += 1;
      log(`Applied ${migration.filename}`);
    }

    log(`Migration complete. Applied ${applied}, skipped ${skipped}.`);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        ADVISORY_LOCK_KEY,
      ]);
    }
    await client.end();
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runMigrations().catch((error) => {
    consoleError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
