DROP INDEX "listings_property_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "listings_property_source_key" ON "listings" USING btree ("property_id","source");