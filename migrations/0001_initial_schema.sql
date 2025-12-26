-- Migration number: 0001 	 2025-12-22T21:44:23.112Z

-- Core metadata tables
CREATE TABLE IF NOT EXISTS feed_source (
    feed_source_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name      TEXT NOT NULL,
    source_desc      TEXT,
    default_lang     TEXT,
    UNIQUE(source_name)
);

CREATE TABLE IF NOT EXISTS feed_version (
    feed_version_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id    INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    version_label     TEXT,
    date_added        INTEGER NOT NULL DEFAULT (unixepoch()),
    feed_start_date   INTEGER,
    feed_end_date     INTEGER,
    is_active         INTEGER NOT NULL DEFAULT 0,
    UNIQUE(feed_source_id, version_label)
);

CREATE TABLE IF NOT EXISTS agency (
    agency_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    agency_id       TEXT,
    agency_name     TEXT NOT NULL,
    agency_url      TEXT NOT NULL,
    agency_timezone TEXT NOT NULL,
    agency_lang     TEXT,
    agency_phone    TEXT,
    agency_fare_url TEXT,
    agency_email    TEXT,
    UNIQUE(feed_version_id, agency_id)
);

CREATE TABLE IF NOT EXISTS feed_info (
    feed_version_id       INTEGER PRIMARY KEY REFERENCES feed_version(feed_version_id),
    feed_publisher_name   TEXT,
    feed_publisher_url    TEXT,
    feed_lang             TEXT,
    feed_version          TEXT,
    feed_start_date       INTEGER,
    feed_end_date         INTEGER,
    feed_contact_email    TEXT,
    feed_contact_url      TEXT
);

-- Core static GTFS tables
CREATE TABLE IF NOT EXISTS routes (
    route_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    route_id          TEXT NOT NULL,
    agency_pk         INTEGER REFERENCES agency(agency_pk),
    route_short_name  TEXT,
    route_long_name   TEXT,
    route_desc        TEXT,
    route_type        INTEGER NOT NULL,
    route_url         TEXT,
    route_color       TEXT,
    route_text_color  TEXT,
    route_sort_order  INTEGER,
    continuous_pickup INTEGER,
    continuous_drop_off INTEGER,
    network_id        TEXT,
    UNIQUE(feed_version_id, route_id)
);

CREATE INDEX IF NOT EXISTS idx_routes_feed_version
    ON routes(feed_version_id);

CREATE INDEX IF NOT EXISTS idx_routes_agency
    ON routes(agency_pk);

CREATE TABLE IF NOT EXISTS stops (
    stop_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    stop_id          TEXT NOT NULL,
    stop_code        TEXT,
    stop_name        TEXT NOT NULL,
    stop_desc        TEXT,
    stop_lat         REAL NOT NULL,
    stop_lon         REAL NOT NULL,
    zone_id          TEXT,
    stop_url         TEXT,
    location_type    INTEGER,
    parent_station   INTEGER REFERENCES stops(stop_pk),
    stop_timezone    TEXT,
    wheelchair_boarding INTEGER,
    level_id         TEXT,
    platform_code    TEXT,
    UNIQUE(feed_version_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_stops_lat_lon
    ON stops(feed_version_id, stop_lat, stop_lon);

CREATE TABLE IF NOT EXISTS calendar (
    service_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    service_id      TEXT NOT NULL,
    monday          INTEGER NOT NULL,
    tuesday         INTEGER NOT NULL,
    wednesday       INTEGER NOT NULL,
    thursday        INTEGER NOT NULL,
    friday          INTEGER NOT NULL,
    saturday        INTEGER NOT NULL,
    sunday          INTEGER NOT NULL,
    start_date      INTEGER NOT NULL,
    end_date        INTEGER NOT NULL,
    UNIQUE(feed_version_id, service_id)
);

CREATE TABLE IF NOT EXISTS calendar_dates (
    caldate_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    service_id      TEXT NOT NULL,
    date            INTEGER NOT NULL,
    exception_type  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
    trip_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    trip_id         TEXT NOT NULL,
    route_pk        INTEGER NOT NULL REFERENCES routes(route_pk),
    service_id      TEXT NOT NULL,
    trip_headsign   TEXT,
    trip_short_name TEXT,
    direction_id    INTEGER,
    block_id        TEXT,
    shape_id        TEXT,
    wheelchair_accessible INTEGER,
    bikes_allowed   INTEGER,
    UNIQUE(feed_version_id, trip_id)
);

CREATE INDEX IF NOT EXISTS idx_trips_feed_version
    ON trips(feed_version_id);

CREATE INDEX IF NOT EXISTS idx_trips_route
    ON trips(route_pk);

CREATE INDEX IF NOT EXISTS idx_trips_service
    ON trips(feed_version_id, service_id);

CREATE TABLE IF NOT EXISTS stop_times (
    stop_time_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_pk          INTEGER NOT NULL REFERENCES trips(trip_pk),
    stop_pk          INTEGER NOT NULL REFERENCES stops(stop_pk),
    stop_sequence    INTEGER NOT NULL,
    arrival_time     INTEGER,
    departure_time   INTEGER,
    stop_headsign    TEXT,
    pickup_type      INTEGER,
    drop_off_type    INTEGER,
    shape_dist_traveled REAL,
    timepoint        INTEGER,
    UNIQUE(trip_pk, stop_sequence)
);

CREATE INDEX IF NOT EXISTS idx_stop_times_trip
    ON stop_times(trip_pk, stop_sequence);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop
    ON stop_times(stop_pk, arrival_time);

CREATE TABLE IF NOT EXISTS shapes (
    shape_pt_pk        INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id    INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    shape_id           TEXT NOT NULL,
    shape_pt_lat       REAL NOT NULL,
    shape_pt_lon       REAL NOT NULL,
    shape_pt_sequence  INTEGER NOT NULL,
    shape_dist_traveled REAL,
    UNIQUE(feed_version_id, shape_id, shape_pt_sequence)
);

CREATE INDEX IF NOT EXISTS idx_shapes_id_seq
    ON shapes(feed_version_id, shape_id, shape_pt_sequence);

-- Optional static GTFS tables
CREATE TABLE IF NOT EXISTS fare_attributes (
    fare_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_id          TEXT NOT NULL,
    price            REAL NOT NULL,
    currency_type    TEXT NOT NULL,
    payment_method   INTEGER NOT NULL,
    transfers        INTEGER,
    agency_pk        INTEGER REFERENCES agency(agency_pk),
    transfer_duration INTEGER,
    UNIQUE(feed_version_id, fare_id)
);

CREATE TABLE IF NOT EXISTS fare_rules (
    fare_rule_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_id          TEXT NOT NULL,
    route_id         TEXT,
    origin_id        TEXT,
    destination_id   TEXT,
    contains_id      TEXT
);

CREATE TABLE IF NOT EXISTS transfers (
    transfer_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    from_stop_pk     INTEGER NOT NULL REFERENCES stops(stop_pk),
    to_stop_pk       INTEGER NOT NULL REFERENCES stops(stop_pk),
    transfer_type    INTEGER NOT NULL,
    min_transfer_time INTEGER
);

CREATE TABLE IF NOT EXISTS frequencies (
    frequency_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_pk          INTEGER NOT NULL REFERENCES trips(trip_pk),
    start_time       INTEGER NOT NULL,
    end_time         INTEGER NOT NULL,
    headway_secs     INTEGER NOT NULL,
    exact_times      INTEGER
);

CREATE TABLE IF NOT EXISTS levels (
    level_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    level_id         TEXT NOT NULL,
    level_index      REAL NOT NULL,
    level_name       TEXT,
    UNIQUE(feed_version_id, level_id)
);

CREATE TABLE IF NOT EXISTS pathways (
    pathway_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    pathway_id       TEXT NOT NULL,
    from_stop_pk     INTEGER NOT NULL REFERENCES stops(stop_pk),
    to_stop_pk       INTEGER NOT NULL REFERENCES stops(stop_pk),
    pathway_mode     INTEGER NOT NULL,
    is_bidirectional INTEGER NOT NULL,
    length           REAL,
    traversal_time   INTEGER,
    stair_count      INTEGER,
    max_slope        REAL,
    min_width        REAL,
    signposted_as    TEXT,
    reversed_signposted_as TEXT,
    UNIQUE(feed_version_id, pathway_id)
);

CREATE TABLE IF NOT EXISTS attributions (
    attribution_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id      INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    attribution_id       TEXT,
    agency_pk            INTEGER REFERENCES agency(agency_pk),
    route_pk             INTEGER REFERENCES routes(route_pk),
    trip_pk              INTEGER REFERENCES trips(trip_pk),
    organization_name    TEXT NOT NULL,
    is_producer          INTEGER,
    is_operator          INTEGER,
    is_authority         INTEGER,
    attribution_url      TEXT,
    attribution_email    TEXT,
    attribution_phone    TEXT
);

-- Realtime tables
CREATE TABLE IF NOT EXISTS vehicle_positions (
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    vehicle_id       TEXT   NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    route_pk         INTEGER REFERENCES routes(route_pk),
    latitude         REAL,
    longitude        REAL,
    speed            REAL,
    heading          REAL,
    timestamp        INTEGER NOT NULL,
    current_status   TEXT,
    occupancy_status TEXT,
    PRIMARY KEY (feed_source_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_positions_route
    ON vehicle_positions(feed_source_id, route_pk);

CREATE INDEX IF NOT EXISTS idx_vehicle_positions_lat_lon
    ON vehicle_positions(feed_source_id, latitude, longitude);

CREATE TABLE IF NOT EXISTS trip_updates (
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    trip_id          TEXT NOT NULL,
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    delay            INTEGER,
    status           TEXT,
    updated_time     INTEGER NOT NULL,
    PRIMARY KEY (feed_source_id, trip_id)
);

CREATE TABLE IF NOT EXISTS service_alerts (
    alert_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    alert_id         TEXT,
    header           TEXT,
    description      TEXT,
    cause            TEXT,
    effect           TEXT,
    start_time       INTEGER,
    end_time         INTEGER,
    severity_level   TEXT,
    affected_route_pk   INTEGER REFERENCES routes(route_pk),
    affected_stop_pk    INTEGER REFERENCES stops(stop_pk),
    affected_trip_pk    INTEGER REFERENCES trips(trip_pk)
);