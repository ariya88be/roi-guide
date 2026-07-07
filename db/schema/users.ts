/**
 * User-owned tables. STRICT per-user isolation is a hard security requirement
 * (brief §9, OWASP A01): every row carries a NOT NULL `user_id`, every query
 * filters by it, and the migration enables PostgreSQL Row-Level Security with
 * policies keyed to `current_setting('app.user_id')`. That is defence in depth:
 * even a query that forgets its WHERE clause cannot cross tenants.
 *
 * `users.id` is the Clerk user id (text) — Clerk is the source of truth for
 * auth; we store only the minimum needed to own rows and send alerts.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/** Default `'{}'::jsonb` for jsonb columns. */
const emptyJsonObject = sql`'{}'::jsonb`;

export const users = pgTable("users", {
  /** Clerk user id. */
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A saved market + budget + target + filters search, owned by one user. */
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** 'budget_return' (budget + target) or 'return_only' (target only). */
    mode: text("mode").notNull(),
    /** Max purchase price; NULL in return-only mode. */
    maxBudget: numeric("max_budget", { precision: 12, scale: 2 }),
    /** The target monthly cash flow T (required in both modes). */
    minMonthlyCashFlow: numeric("min_monthly_cash_flow", { precision: 12, scale: 2 }).notNull(),
    /** Area of interest: { zips? , bbox? } — validated with Zod at the API. */
    area: jsonb("area").notNull().default(emptyJsonObject),
    /** Property-type filters, exclusions, and assumption overrides. */
    filters: jsonb("filters").notNull().default(emptyJsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("saved_searches_user_idx").on(t.userId)],
);

/** An alert derived from a saved search; checked by n8n against new listings. */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    savedSearchId: uuid("saved_search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("alerts_user_idx").on(t.userId), index("alerts_saved_search_idx").on(t.savedSearchId)],
);

/** Tables that must have Row-Level Security enabled in the migration. */
export const RLS_PROTECTED_TABLES = ["users", "saved_searches", "alerts"] as const;
