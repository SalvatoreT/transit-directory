-- Migration number: 0011 	 2026-05-02T00:00:00.000Z

-- Collapse trip_updates back to one row per (feed_source_id, trip_id).
--
-- The historical layout introduced in 0002 produced enormous write traffic
-- (each fetch wrote a fresh row per active trip across 5 secondary indexes,
-- then the hourly cleanup deleted them again two hours later) even though
-- every reader in the codebase only ever consumes the latest row per
-- trip_pk via a MAX(update_pk) subquery. Switching to an UPSERT model on
-- (feed_source_id, trip_id) removes the history accumulation, lets the
-- ingest path skip rows whose payload has not changed, and lets us drop
-- the indexes that only existed to support history queries and cleanup.

CREATE TABLE trip_updates_new (
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    trip_id          TEXT NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    delay            INTEGER,
    status           TEXT,
    updated_time     INTEGER NOT NULL,
    PRIMARY KEY (feed_source_id, trip_id)
);

-- Keep only the freshest row per (feed_source_id, trip_id).
INSERT INTO trip_updates_new (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
SELECT feed_source_id, trip_id, trip_pk, delay, status, updated_time
FROM trip_updates AS tu
WHERE tu.update_pk = (
    SELECT MAX(tu2.update_pk)
    FROM trip_updates AS tu2
    WHERE tu2.feed_source_id = tu.feed_source_id
      AND tu2.trip_id = tu.trip_id
);

DROP TABLE trip_updates;
ALTER TABLE trip_updates_new RENAME TO trip_updates;

-- The PK on (feed_source_id, trip_id) covers the prior idx_trip_updates_trip_id
-- prefix lookups. idx_trip_updates_time and idx_trip_updates_unique_ingest
-- supported the cleanup DELETE and the historical INSERT-OR-IGNORE dedupe;
-- both are obsolete. idx_trip_updates_trip_pk_update was a covering index for
-- MAX(update_pk), which no longer exists. Only the trip_pk join index remains.
CREATE INDEX idx_trip_updates_trip_pk ON trip_updates(trip_pk);
