-- Migration number: 0017 	 2026-08-09T00:00:00.000Z

-- Records when a feed version's import ran to completion.
--
-- Until now `is_active` doubled as that marker: the import flipped it on as
-- its last step, so "fully imported" and "currently served" were the same
-- bit. That forced every freshly downloaded feed to go live the moment it
-- finished importing, even when its service window had not opened yet. A
-- BART feed published on 2026-08-07 whose first service day was 2026-08-10
-- replaced a version that did cover those dates, leaving three days with no
-- scheduled departures at all.
--
-- Splitting the two lets an import finish and then wait for a later run to
-- promote it once it actually has service to serve.
ALTER TABLE feed_version ADD COLUMN imported_at INTEGER;

-- Existing versions that hold trip data completed their import under the old
-- code, so they are eligible to be served. Versions with no trips are treated
-- as partial imports and get re-imported the next time their content is
-- fetched.
UPDATE feed_version
SET imported_at = date_added
WHERE EXISTS (
    SELECT 1 FROM trips t WHERE t.feed_version_id = feed_version.feed_version_id
);
