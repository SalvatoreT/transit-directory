-- Migration number: 0014 	 2026-05-19T00:00:00.000Z

-- Drop service_alerts and vehicle_positions.
--
-- service_alerts had no reader anywhere in the application and was the
-- dominant source of D1 row writes: every realtime poll INSERTed every
-- alert (no UPSERT, no dedupe), and the hourly cleanup cron DELETEd up
-- to 5000 rows per run. The table accumulated millions of historical
-- rows over time.
--
-- vehicle_positions was never written by the realtime workflow and had
-- no reader. The only references were FK-cleanup statements in
-- Import511Workflow.ts, which have been removed in the same change.
--
-- SQLite drops associated indexes automatically when a table is dropped,
-- but we drop them explicitly first for clarity.

DROP INDEX IF EXISTS idx_service_alerts_feed_active;
DROP INDEX IF EXISTS idx_service_alerts_end_time;
DROP TABLE IF EXISTS service_alerts;

DROP INDEX IF EXISTS idx_vehicle_positions_route;
DROP INDEX IF EXISTS idx_vehicle_positions_lat_lon;
DROP TABLE IF EXISTS vehicle_positions;
