-- Migration 0007 added these for the regional realtime import's unscoped
-- ID lookups. The import has been retired. Static ID lookups bind a feed
-- version and use the UNIQUE(feed_version_id, *_id) indexes from 0001.
DROP INDEX IF EXISTS idx_trips_trip_id;
DROP INDEX IF EXISTS idx_routes_route_id;
DROP INDEX IF EXISTS idx_stops_stop_id;
