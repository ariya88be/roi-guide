import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config. `generate` (offline) diffs the schema and writes SQL
 * migrations to ./db/migrations. `migrate`/`push`/`studio` need a live
 * DATABASE_URL and are run once Railway Postgres is provisioned.
 */
export default defineConfig({
  schema: "./db/schema/index.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Only consumed by migrate/push/studio; generate does not connect.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
