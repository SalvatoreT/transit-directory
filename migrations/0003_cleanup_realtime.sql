-- Migration number: 0003 	 2025-12-26T00:00:00.000Z

-- 1. Clean up existing duplicate trip updates (keep the one with the highest update_pk)
DELETE FROM trip_updates
WHERE update_pk NOT IN (
    SELECT MAX(update_pk)
    FROM trip_updates
    GROUP BY feed_source_id, trip_id, updated_time
);

-- 2. Add a unique index to prevent future duplicates of the same update
CREATE UNIQUE INDEX idx_trip_updates_unique_ingest ON trip_updates(feed_source_id, trip_id, updated_time);

-- 3. Also fix vehicle_positions to be historical if we want to follow the same pattern, 
-- but the user only complained about train times (trip updates).
-- For now, let's just ensure trip_updates is clean.
