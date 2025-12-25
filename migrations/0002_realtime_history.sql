-- Migration number: 0002 	 2025-12-25T00:00:00.000Z

-- Make trip_updates historical by removing the PK on (feed_source_id, trip_id)
CREATE TABLE trip_updates_new (
    update_pk        INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    trip_id          TEXT NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    delay            INTEGER,
    status           TEXT,
    updated_time     TEXT NOT NULL
);

INSERT INTO trip_updates_new (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
SELECT feed_source_id, trip_id, trip_pk, delay, status, updated_time FROM trip_updates;

DROP TABLE trip_updates;
ALTER TABLE trip_updates_new RENAME TO trip_updates;

CREATE INDEX idx_trip_updates_trip_id ON trip_updates(feed_source_id, trip_id);
CREATE INDEX idx_trip_updates_time ON trip_updates(updated_time);


-- Make vehicle_positions historical by removing the PK on (feed_source_id, vehicle_id)
CREATE TABLE vehicle_positions_new (
    vp_pk            INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    vehicle_id       TEXT   NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    route_pk         INTEGER REFERENCES routes(route_pk),
    latitude         REAL,
    longitude        REAL,
    speed            REAL,
    heading          REAL,
    timestamp        TEXT NOT NULL,
    current_status   TEXT,
    occupancy_status TEXT
);

INSERT INTO vehicle_positions_new (feed_source_id, vehicle_id, trip_pk, route_pk, latitude, longitude, speed, heading, timestamp, current_status, occupancy_status)
SELECT feed_source_id, vehicle_id, trip_pk, route_pk, latitude, longitude, speed, heading, timestamp, current_status, occupancy_status FROM vehicle_positions;

DROP TABLE vehicle_positions;
ALTER TABLE vehicle_positions_new RENAME TO vehicle_positions;

CREATE INDEX idx_vehicle_positions_vehicle ON vehicle_positions(feed_source_id, vehicle_id);
CREATE INDEX idx_vehicle_positions_time ON vehicle_positions(timestamp);
