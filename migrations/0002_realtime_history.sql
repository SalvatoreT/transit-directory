-- Migration number: 0002 	 2025-12-24T00:00:00.000Z

-- Make trip_updates historical by removing the PK on (feed_source_id, trip_id)
CREATE TABLE trip_updates_new (
    update_pk        INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    trip_id          TEXT NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    delay            INTEGER,
    status           TEXT,
    updated_time     INTEGER NOT NULL
);

INSERT INTO trip_updates_new (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
SELECT feed_source_id, trip_id, trip_pk, delay, status, updated_time FROM trip_updates;

DROP TABLE trip_updates;
ALTER TABLE trip_updates_new RENAME TO trip_updates;

CREATE INDEX idx_trip_updates_trip_id ON trip_updates(feed_source_id, trip_id);
CREATE INDEX idx_trip_updates_time ON trip_updates(updated_time);