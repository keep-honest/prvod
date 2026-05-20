import { describe, expect, it } from "vitest";
import {
  checksumSql,
  decideInitialSchemaMode,
  planMigrationRecord,
  sortMigrationFilenames,
  splitSqlStatements,
  validateDatabaseUrl,
} from "../../../scripts/migrate.mjs";

describe("migration runner helpers", () => {
  it("requires a postgresql DATABASE_URL", () => {
    expect(() => validateDatabaseUrl(undefined)).toThrow(/DATABASE_URL is required/);
    expect(() => validateDatabaseUrl("postgres://user:pass@example.com/db")).toThrow(
      /must start with postgresql:\/\//,
    );
    expect(validateDatabaseUrl(" postgresql://user:pass@example.com/db ")).toBe(
      "postgresql://user:pass@example.com/db",
    );
  });

  it("sorts only SQL migration files lexicographically", () => {
    expect(
      sortMigrationFilenames([
        "0010_later.sql",
        "_journal.json",
        "0002_second.sql",
        "0001_first.sql",
      ]),
    ).toEqual(["0001_first.sql", "0002_second.sql", "0010_later.sql"]);
  });

  it("splits SQL on Drizzle statement breakpoints and drops empty statements", () => {
    expect(
      splitSqlStatements(`
        CREATE TABLE one (id text);
        --> statement-breakpoint

        --> statement-breakpoint
        CREATE INDEX one_idx ON one (id);
      `),
    ).toEqual([
      "CREATE TABLE one (id text);",
      "CREATE INDEX one_idx ON one (id);",
    ]);
  });

  it("detects applied, skipped, and checksum-mismatch migration states", () => {
    const checksum = checksumSql("SELECT 1;");

    expect(planMigrationRecord("0001.sql", checksum, null)).toEqual({
      action: "apply",
    });
    expect(
      planMigrationRecord("0001.sql", checksum, {
        filename: "0001.sql",
        checksum,
      }),
    ).toEqual({ action: "skip" });
    expect(
      planMigrationRecord("0001.sql", checksum, {
        filename: "0001.sql",
        checksum: "old",
      }),
    ).toMatchObject({
      action: "checksum_mismatch",
      message: expect.stringContaining("0001.sql"),
    });
  });

  it("chooses baseline mode only for existing schemas when explicitly requested", () => {
    expect(
      decideInitialSchemaMode({
        trackingTableExists: false,
        existingPublicTableCount: 0,
        baselineRequested: false,
      }),
    ).toBe("run");
    expect(
      decideInitialSchemaMode({
        trackingTableExists: true,
        existingPublicTableCount: 10,
        baselineRequested: false,
      }),
    ).toBe("run");
    expect(
      decideInitialSchemaMode({
        trackingTableExists: false,
        existingPublicTableCount: 3,
        baselineRequested: false,
      }),
    ).toBe("fail_existing_schema");
    expect(
      decideInitialSchemaMode({
        trackingTableExists: false,
        existingPublicTableCount: 3,
        baselineRequested: true,
      }),
    ).toBe("baseline");
  });
});
