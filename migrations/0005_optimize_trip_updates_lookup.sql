-- Migration number: 0005 	 2026-01-04T00:00:00.000Z

-- Add index to trip_updates on trip_pk to optimize joins
CREATE INDEX IF NOT EXISTS idx_trip_updates_trip_pk ON trip_updates(trip_pk);

-- Add index to calendar_dates to optimize service availability lookups
CREATE INDEX IF NOT EXISTS idx_calendar_dates_lookup ON calendar_dates(feed_version_id, service_id, date);
