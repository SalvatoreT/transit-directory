-- Migration number: 0007 	 2026-03-02T00:00:00.000Z

-- Add standalone indexes on trip_id, route_id, and stop_id to support
-- efficient IN(...) lookups in Import511RealtimeWorkflow.
-- The existing UNIQUE(feed_version_id, trip_id/route_id/stop_id) indexes
-- cannot be used because feed_version_id is the leading column and the
-- queries filter on trip_id/route_id/stop_id alone.
CREATE INDEX IF NOT EXISTS idx_trips_trip_id ON trips(trip_id);
CREATE INDEX IF NOT EXISTS idx_routes_route_id ON routes(route_id);
CREATE INDEX IF NOT EXISTS idx_stops_stop_id ON stops(stop_id);
