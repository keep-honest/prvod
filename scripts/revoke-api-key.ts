#!/usr/bin/env tsx
/**
 * Revoke an API key by its keyId.
 *
 * Usage:
 *   npx tsx scripts/revoke-api-key.ts <keyId>
 *
 * Automatically loads .env from the project root.
 */

import "./load-env";
import { eq } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { apiKeys } from "@/infrastructure/persistence/schema";

async function main() {
  const keyId = process.argv[2];
  if (!keyId) {
    console.error("Usage: tsx scripts/revoke-api-key.ts <keyId>");
    process.exit(1);
  }

  const db = getDb();
  const [key] = await db.select({ id: apiKeys.id, status: apiKeys.status })
    .from(apiKeys)
    .where(eq(apiKeys.keyId, keyId))
    .limit(1);

  if (!key) {
    console.error(`Key not found: ${keyId}`);
    process.exit(1);
  }

  if (key.status === "revoked") {
    console.log(`Key already revoked: ${keyId}`);
    process.exit(0);
  }

  await db.update(apiKeys)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(apiKeys.keyId, keyId));

  console.log(`Key revoked: ${keyId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to revoke API key:", err instanceof Error ? err.message : err);
  process.exit(1);
});
