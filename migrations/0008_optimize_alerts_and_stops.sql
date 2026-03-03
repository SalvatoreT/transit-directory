-- Migration number: 0008 	 2026-03-03T00:00:00.000Z

-- Fix index mismatch for departures query: the existing idx_stop_times_stop
-- covers (stop_pk, arrival_time) but the departures query filters on
-- departure_time. This new index allows the range scan on departure_time to
-- be satisfied directly through the B-tree.
CREATE INDEX IF NOT EXISTS idx_stop_times_departure
    ON stop_times(stop_pk, departure_time);

-- Cover the stops-by-parent_station lookup. Without this index the query must
-- scan all stops for a given feed_version_id to filter by parent_station.
CREATE INDEX IF NOT EXISTS idx_stops_parent_station
    ON stops(feed_version_id, parent_station);
