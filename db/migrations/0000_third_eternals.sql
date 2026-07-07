-- PostGIS must exist before any geometry column is created (hand-added; drizzle-kit does not manage extensions).
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TABLE "computed_roi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"median_rent" numeric(10, 2) NOT NULL,
	"avm_rent" numeric(10, 2),
	"monthly_cash_flow" numeric(12, 2) NOT NULL,
	"color_band" text NOT NULL,
	"confidence_score" integer NOT NULL,
	"confidence_level" text NOT NULL,
	"de_emphasize" boolean DEFAULT false NOT NULL,
	"hoa_missing" boolean DEFAULT false NOT NULL,
	"tax_estimated" boolean DEFAULT false NOT NULL,
	"insurance_estimated" boolean DEFAULT false NOT NULL,
	"assumptions_hash" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"source" text DEFAULT 'rentcast' NOT NULL,
	"status" text NOT NULL,
	"listing_type" text,
	"price" numeric(12, 2) NOT NULL,
	"hoa_fee" numeric(10, 2),
	"listed_date" date,
	"removed_date" date,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"missed_sync_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zip_code" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"active_rental_listings" integer,
	"average_rent" numeric(10, 2),
	"median_rent" numeric(10, 2),
	"min_rent" numeric(10, 2),
	"max_rent" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rentcast_id" text NOT NULL,
	"formatted_address" text,
	"address_line1" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"location" geometry(Point,4326) NOT NULL,
	"property_type" text,
	"bedrooms" numeric(3, 1),
	"bathrooms" numeric(3, 1),
	"square_footage" integer,
	"lot_size" integer,
	"year_built" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rent_comps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"rent" numeric(10, 2) NOT NULL,
	"location" geometry(Point,4326),
	"bedrooms" numeric(3, 1),
	"bathrooms" numeric(3, 1),
	"square_footage" integer,
	"distance_miles" numeric(6, 3),
	"age_days" integer NOT NULL,
	"correlation" numeric(4, 3),
	"source" text DEFAULT 'rentcast' NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"max_budget" numeric(12, 2),
	"min_monthly_cash_flow" numeric(12, 2) NOT NULL,
	"area" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computed_roi" ADD CONSTRAINT "computed_roi_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computed_roi" ADD CONSTRAINT "computed_roi_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_comps" ADD CONSTRAINT "rent_comps_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computed_roi_listing_key" ON "computed_roi" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "computed_roi_property_idx" ON "computed_roi" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "computed_roi_band_idx" ON "computed_roi" USING btree ("color_band");--> statement-breakpoint
CREATE INDEX "listings_property_idx" ON "listings" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listings_active_idx" ON "listings" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "market_snapshots_zip_date_key" ON "market_snapshots" USING btree ("zip_code","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_rentcast_id_key" ON "properties" USING btree ("rentcast_id");--> statement-breakpoint
CREATE INDEX "properties_zip_idx" ON "properties" USING btree ("zip_code");--> statement-breakpoint
CREATE INDEX "properties_location_gix" ON "properties" USING gist ("location");--> statement-breakpoint
CREATE INDEX "rent_comps_property_idx" ON "rent_comps" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "rent_comps_location_gix" ON "rent_comps" USING gist ("location");--> statement-breakpoint
CREATE INDEX "alerts_user_idx" ON "alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alerts_saved_search_idx" ON "alerts" USING btree ("saved_search_id");--> statement-breakpoint
CREATE INDEX "saved_searches_user_idx" ON "saved_searches" USING btree ("user_id");--> statement-breakpoint
-- ============================================================================
-- Row-Level Security (hand-added; drizzle-kit does not manage RLS).
-- Strict per-user isolation (brief §9 / OWASP A01), defence in depth on top of
-- explicit WHERE user_id = ... filters in the query layer. Every user-scoped
-- request must run inside a transaction that sets app.user_id (see db/client.ts
-- withUser). FORCE makes even the table owner (the app's Railway role) subject
-- to the policy. current_setting(..., true) returns NULL when unset, so an
-- un-scoped connection sees ZERO rows (fail closed).
-- NOTE: cross-user workers (e.g. the n8n alert checker) must iterate per user
-- and set app.user_id for each, or use a dedicated BYPASSRLS role.
-- ============================================================================
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "users_isolation" ON "users"
	USING ("id" = current_setting('app.user_id', true))
	WITH CHECK ("id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "saved_searches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_searches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "saved_searches_isolation" ON "saved_searches"
	USING ("user_id" = current_setting('app.user_id', true))
	WITH CHECK ("user_id" = current_setting('app.user_id', true));--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "alerts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "alerts_isolation" ON "alerts"
	USING ("user_id" = current_setting('app.user_id', true))
	WITH CHECK ("user_id" = current_setting('app.user_id', true));