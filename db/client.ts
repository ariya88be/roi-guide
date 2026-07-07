/**
 * Drizzle database client — SERVER-SIDE ONLY.
 *
 * Reads `DATABASE_URL` from the server env (never exposed to the browser). The
 * connection is created lazily and memoised so route handlers and workers share
 * one pool. Do not import this from client components.
 *
 * Per-user isolation (brief §9): user-scoped queries must run inside
 * {@link withUser}, which sets `app.user_id` for the transaction so PostgreSQL
 * Row-Level Security policies apply. This is defence in depth on top of explicit
 * `where(eq(table.userId, ...))` filters in the query layer.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let singleton: { db: Database; sqlClient: postgres.Sql } | undefined;

function connect(): { db: Database; sqlClient: postgres.Sql } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (server-side env). Cannot open a database connection.");
  }
  const sqlClient = postgres(url, { max: 10 });
  const db = drizzle(sqlClient, { schema });
  return { db, sqlClient };
}

/** The shared Drizzle instance (opens the pool on first use). */
export function getDb(): Database {
  singleton ??= connect();
  return singleton.db;
}

/**
 * Run `fn` inside a transaction that has `app.user_id` set to `userId`, so RLS
 * policies scope every read/write to that user. Always use this for user-owned
 * data access.
 */
export async function withUser<T>(userId: string, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // set_config(..., true) => scoped to this transaction only.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Database);
  });
}
