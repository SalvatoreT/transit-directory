-- Migration number: 0009 	 2026-03-07T00:00:00.000Z

-- Covering index for the correlated MAX(update_pk) subquery used in the
-- departures and trip-stops queries. The existing idx_trip_updates_trip_pk
-- only has trip_pk, forcing a table lookup to read update_pk for every row.
-- With (trip_pk, update_pk) the MAX can be resolved from the index B-tree
-- alone (rightmost entry in each trip_pk range = single seek).
CREATE INDEX IF NOT EXISTS idx_trip_updates_trip_pk_update
    ON trip_updates(trip_pk, update_pk);

-- When the departures query filters by route_pk the optimal join path is
-- routes -> trips -> stop_times. The existing idx_stop_times_trip covers
-- (trip_pk, stop_sequence) which does not help with the departure_time range
-- filter, forcing a scan of all stop_times per trip. This index lets SQLite
-- range-scan departure_time within a given trip_pk.
CREATE INDEX IF NOT EXISTS idx_stop_times_trip_departure
    ON stop_times(trip_pk, departure_time);
