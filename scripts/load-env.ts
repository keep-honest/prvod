/**
 * Loads .env from the project root into process.env.
 * Import this at the top of any standalone script that needs env vars.
 *
 * Does not override vars already set on the command line.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(import.meta.dirname ?? __dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values: strip inline comments (# preceded by whitespace)
      const commentIdx = value.search(/\s+#/);
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trimEnd();
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
