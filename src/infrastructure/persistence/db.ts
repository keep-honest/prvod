import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { createLogger } from "@/lib/logger";
import { redactUrl } from "@/lib/url";

const logger = createLogger();

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  const trimmedUrl = databaseUrl.trim();
  if (!/^postgresql:\/\//.test(trimmedUrl)) {
    throw new Error("DATABASE_URL must start with 'postgresql://'");
  }
  logger.info("Connecting to database", { target: redactUrl(trimmedUrl) });
  return drizzle(new Pool({ connectionString: trimmedUrl }), { schema });
}

export type Database = ReturnType<typeof createDb>;

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    db = createDb();
  }
  return db;
}
