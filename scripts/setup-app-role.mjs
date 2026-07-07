/**
 * Create the non-superuser application role `roi_app`.
 *
 * WHY: PostgreSQL superusers (Railway's default `postgres` user) BYPASS Row-Level
 * Security even when it is FORCED. For our per-user isolation policies to
 * actually take effect, the application must connect as a NON-superuser role.
 * Migrations still run as `postgres` (they need superuser for CREATE EXTENSION).
 *
 * Run once (and again after adding tables) with:
 *   DATABASE_URL=<postgres superuser url> APP_DB_PASSWORD=<pw> \
 *     node scripts/setup-app-role.mjs
 *
 * Idempotent. Never commit the password.
 */
import postgres from "postgres";

const adminUrl = process.env.DATABASE_URL;
const pw = process.env.APP_DB_PASSWORD;
if (!adminUrl) throw new Error("DATABASE_URL (superuser) is required");
if (!pw || !/^[A-Za-z0-9]{16,}$/.test(pw)) {
  throw new Error("APP_DB_PASSWORD must be an alphanumeric string of length >= 16");
}

const sql = postgres(adminUrl, { ssl: false, max: 1 });
try {
  // Create or update the role. Password is alphanumeric (validated above), safe to embed.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'roi_app') THEN
        CREATE ROLE roi_app LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      ELSE
        ALTER ROLE roi_app WITH LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
  `);

  // Least-privilege grants: DML on existing + future tables, no DDL.
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO roi_app`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO roi_app`);
  await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO roi_app`);
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO roi_app`,
  );

  // Sanity: confirm the role is NOT a superuser and does NOT bypass RLS.
  const [r] = await sql`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'roi_app'`;
  console.log(`roi_app ready: superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
  if (r.rolsuper || r.rolbypassrls) throw new Error("roi_app must not be superuser or bypassrls");
} finally {
  await sql.end();
}
