import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  const trimmedUrl = databaseUrl.trim();
  if (!/^postgresql:\/\//.test(trimmedUrl)) {
    throw new Error("DATABASE_URL must start with 'postgresql://'");
  }
  console.log(`Connecting to database at ${trimmedUrl}...`);
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
