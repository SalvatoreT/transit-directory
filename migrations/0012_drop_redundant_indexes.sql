-- Migration number: 0012 	 2026-05-10T00:00:00.000Z

-- The UNIQUE(trip_pk, stop_sequence) constraint already creates an equivalent
-- auto-index, so idx_stop_times_trip is a pure duplicate. Every stop_times
-- insert was writing to both, adding ~17% of the index amplification for
-- nothing.
DROP INDEX IF EXISTS idx_stop_times_trip;

-- idx_stop_times_stop (stop_pk, arrival_time) was added for the departures
-- query in migration 0001, but migration 0008 superseded it with
-- idx_stop_times_departure (stop_pk, departure_time) once we noticed the
-- query filters on departure_time. arrival_time is never used in a WHERE
-- clause, so this index is dead weight on every insert.
DROP INDEX IF EXISTS idx_stop_times_stop;

-- Same duplicate-of-UNIQUE pattern: UNIQUE(feed_version_id, shape_id,
-- shape_pt_sequence) already provides the lookup index.
DROP INDEX IF EXISTS idx_shapes_id_seq;
