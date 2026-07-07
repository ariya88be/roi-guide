/**
 * Static guardrails on the generated SQL migrations.
 *
 * We can't run PostGIS/RLS against a live database until Railway is provisioned,
 * but the security-critical DDL (PostGIS extension, SRID-4326 geometry, GiST
 * indexes, and Row-Level Security) is hand-added to the migration and MUST NOT
 * be lost on a future `db:generate`. These assertions fail loudly if it is —
 * covering the migration side of QA §15.H (geospatial) and §15.M (isolation).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");

/** Concatenate every .sql migration into one string for assertions. */
function allMigrationsSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  return files.map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).join("\n");
}

const sqlText = allMigrationsSql();

describe("migration: PostGIS geospatial DDL (QA §15.H)", () => {
  it("creates the PostGIS extension", () => {
    expect(sqlText).toMatch(/CREATE EXTENSION IF NOT EXISTS postgis/i);
  });

  it("uses SRID-4326 geometry for location columns", () => {
    expect(sqlText).toMatch(/geometry\(Point,4326\)/);
  });

  it("never leaves an SRID-less geometry(point) column", () => {
    expect(sqlText.toLowerCase()).not.toMatch(/geometry\(point\)/);
  });

  it("builds GiST spatial indexes on both location columns", () => {
    expect(sqlText).toMatch(/CREATE INDEX "properties_location_gix" ON "properties" USING gist/i);
    expect(sqlText).toMatch(/CREATE INDEX "rent_comps_location_gix" ON "rent_comps" USING gist/i);
  });
});

describe("migration: per-user isolation / RLS (QA §15.M)", () => {
  const protectedTables = ["users", "saved_searches", "alerts"];

  it("enables AND forces RLS on every user-owned table", () => {
    for (const t of protectedTables) {
      expect(sqlText).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(sqlText).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
    }
  });

  it("creates an isolation policy keyed to app.user_id for each", () => {
    for (const t of protectedTables) {
      expect(sqlText).toMatch(new RegExp(`CREATE POLICY "${t}_isolation" ON "${t}"`));
    }
    // The policy predicate must reference the per-transaction user id setting.
    expect(sqlText).toMatch(/current_setting\('app\.user_id', true\)/);
  });

  it("marks user_id NOT NULL on saved_searches and alerts", () => {
    expect(sqlText).toMatch(/"user_id" text NOT NULL/);
  });
});
