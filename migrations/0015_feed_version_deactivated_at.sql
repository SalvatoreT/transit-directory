-- Migration number: 0015 	 2026-06-11T00:00:00.000Z

-- Track when a feed version stopped being the active one. Retention-based
-- cleanup (delete a version's data N days after it was superseded) needs
-- this; date_added cannot express it because a version is often weeks old
-- by the time a newer import replaces it.
ALTER TABLE feed_version ADD COLUMN deactivated_at INTEGER;

-- Versions deactivated before this column existed start their retention
-- clock now.
UPDATE feed_version SET deactivated_at = unixepoch() WHERE is_active = 0;
