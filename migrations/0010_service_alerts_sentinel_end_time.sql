-- Migration number: 0010 	 2026-03-16T00:00:00.000Z

-- Replace NULL end_time values with a far-future sentinel (year 9999 epoch)
-- so the composite index on (feed_source_id, end_time) can satisfy
-- `end_time > ?` as a single contiguous range scan without needing
-- `OR end_time IS NULL`.
UPDATE service_alerts SET end_time = 253402300799 WHERE end_time IS NULL;
