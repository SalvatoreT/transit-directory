-- Migration number: 0013 	 2026-05-10T00:00:00.000Z

-- The hourly cleanup query
--
--   DELETE FROM service_alerts WHERE alert_pk IN (
--     SELECT alert_pk FROM service_alerts
--     WHERE end_time < ? AND end_time != 253402300799
--     LIMIT 5000
--   )
--
-- only filters by end_time. The existing idx_service_alerts_feed_active is
-- (feed_source_id, end_time), and without a feed_source_id predicate SQLite
-- cannot range-scan it on end_time, so every cleanup call falls back to a
-- full table scan (~300M rows read over a few hundred invocations). A
-- single-column index on end_time turns that into a bounded LIMIT-sized
-- range scan.
CREATE INDEX IF NOT EXISTS idx_service_alerts_end_time
    ON service_alerts(end_time);
