#!/usr/bin/env tsx
/**
 * Create an admin API key and print it once.
 *
 * Usage:
 *   APP_ENCRYPTION_KEY=<same as the server or empty if not set> npx tsx scripts/create-admin-api-key.ts [name]
 *
 * Automatically loads .env from the project root.
 * The full key (keyId.secret) is printed exactly once — store it securely.
 */

import "./load-env";
import { randomBytes } from "crypto";
import { hash } from "@node-rs/argon2";
import { getDb } from "@/infrastructure/persistence/db";
import { apiKeys } from "@/infrastructure/persistence/schema";

async function main() {
  const name = process.argv[2] ?? "admin-key";

  const keyId = "pk_" + randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("hex");

  const pepper = process.env.APP_ENCRYPTION_KEY ?? "";
  if (!pepper) {
    console.warn("WARNING: APP_ENCRYPTION_KEY is not set — key will be hashed without a pepper (insecure in production)");
  }
  const keyHash = await hash(pepper + secret);

  const db = getDb();
  await db.insert(apiKeys).values({
    keyId,
    keyHash,
    name,
    isAdmin: true,
    scopes: ["*"],
    status: "active",
  });

  const fullKey = `${keyId}.${secret}`;
  console.log("\n=== API Key Created ===");
  console.log(`Name   : ${name}`);
  console.log(`Key ID : ${keyId}`);
  console.log(`Full Key (save this — shown only once):\n  ${fullKey}`);
  console.log("======================\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create API key:", err instanceof Error ? err.message : err);
  process.exit(1);
});
