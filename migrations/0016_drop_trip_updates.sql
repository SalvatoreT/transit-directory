-- Migration number: 0016 	 2026-06-30T00:00:00.000Z

-- Drop trip_updates.
--
-- Realtime delays are no longer stored in D1. The background polling workflow
-- (Import511RealtimeWorkflow) that upserted this table has been removed; pages
-- now fetch the GTFS-RT TripUpdates feed on demand, cache the raw payload in
-- the Cloudflare Cache API, and merge delay/status into query results in JS.
-- With no writer and no reader left, the table is dropped.
--
-- trip_updates is a state table (one row per (feed_source_id, trip_id)), so it
-- holds at most a few thousand rows and DROP TABLE stays well within D1's
-- per-query execution limits. SQLite drops associated indexes with the table;
-- we drop the surviving index explicitly first for clarity.

DROP INDEX IF EXISTS idx_trip_updates_trip_pk;
DROP TABLE IF EXISTS trip_updates;
