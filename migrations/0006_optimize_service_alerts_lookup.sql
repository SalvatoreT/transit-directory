-- Migration number: 0006 	 2026-03-01T00:00:00.000Z

-- Add composite index on service_alerts to optimize the active-alerts lookup
-- used in Import511RealtimeWorkflow (feed_source_id equality + end_time range/NULL).
CREATE INDEX IF NOT EXISTS idx_service_alerts_feed_active
    ON service_alerts(feed_source_id, end_time);
