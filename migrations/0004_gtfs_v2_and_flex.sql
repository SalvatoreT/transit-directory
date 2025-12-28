-- Migration number: 0004 	 2025-12-27T00:00:00.000Z

-- Add missing columns to existing tables
ALTER TABLE agency ADD COLUMN cemv_support INTEGER;

ALTER TABLE stops ADD COLUMN tts_stop_name TEXT;
ALTER TABLE stops ADD COLUMN stop_access INTEGER;

ALTER TABLE routes ADD COLUMN cemv_support INTEGER;

ALTER TABLE trips ADD COLUMN cars_allowed INTEGER;

ALTER TABLE stop_times ADD COLUMN location_group_id TEXT;
ALTER TABLE stop_times ADD COLUMN location_id TEXT;
ALTER TABLE stop_times ADD COLUMN start_pickup_drop_off_window INTEGER;
ALTER TABLE stop_times ADD COLUMN end_pickup_drop_off_window INTEGER;
ALTER TABLE stop_times ADD COLUMN continuous_pickup INTEGER;
ALTER TABLE stop_times ADD COLUMN continuous_drop_off INTEGER;
ALTER TABLE stop_times ADD COLUMN pickup_booking_rule_id TEXT;
ALTER TABLE stop_times ADD COLUMN drop_off_booking_rule_id TEXT;

ALTER TABLE transfers ADD COLUMN from_route_pk INTEGER REFERENCES routes(route_pk);
ALTER TABLE transfers ADD COLUMN to_route_pk INTEGER REFERENCES routes(route_pk);
ALTER TABLE transfers ADD COLUMN from_trip_pk INTEGER REFERENCES trips(trip_pk);
ALTER TABLE transfers ADD COLUMN to_trip_pk INTEGER REFERENCES trips(trip_pk);

ALTER TABLE feed_info ADD COLUMN default_lang TEXT;

-- New tables for GTFS-Fares V2 and GTFS-Flex

CREATE TABLE IF NOT EXISTS areas (
    area_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    area_id          TEXT NOT NULL,
    area_name        TEXT,
    UNIQUE(feed_version_id, area_id)
);

CREATE TABLE IF NOT EXISTS stop_areas (
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    area_id          TEXT NOT NULL,
    stop_id          TEXT NOT NULL,
    PRIMARY KEY (feed_version_id, area_id, stop_id)
);

CREATE TABLE IF NOT EXISTS networks (
    network_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    network_id       TEXT NOT NULL,
    network_name     TEXT,
    UNIQUE(feed_version_id, network_id)
);

CREATE TABLE IF NOT EXISTS route_networks (
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    network_id       TEXT NOT NULL,
    route_id         TEXT NOT NULL,
    PRIMARY KEY (feed_version_id, network_id, route_id)
);

CREATE TABLE IF NOT EXISTS timeframes (
    timeframe_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    timeframe_group_id TEXT NOT NULL,
    start_time       INTEGER,
    end_time         INTEGER,
    service_id       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeframes_lookup ON timeframes(feed_version_id, timeframe_group_id);

CREATE TABLE IF NOT EXISTS rider_categories (
    rider_category_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    rider_category_id TEXT NOT NULL,
    rider_category_name TEXT NOT NULL,
    is_default_fare_category INTEGER NOT NULL,
    eligibility_url   TEXT,
    UNIQUE(feed_version_id, rider_category_id)
);

CREATE TABLE IF NOT EXISTS fare_media (
    fare_media_pk    INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_media_id    TEXT NOT NULL,
    fare_media_name  TEXT,
    fare_media_type  INTEGER NOT NULL,
    UNIQUE(feed_version_id, fare_media_id)
);

CREATE TABLE IF NOT EXISTS fare_products (
    fare_product_pk  INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_product_id  TEXT NOT NULL,
    fare_product_name TEXT,
    rider_category_id TEXT,
    fare_media_id    TEXT,
    amount           REAL NOT NULL,
    currency         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fare_products_lookup ON fare_products(feed_version_id, fare_product_id);

CREATE TABLE IF NOT EXISTS fare_leg_rules (
    fare_leg_rule_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    leg_group_id     TEXT,
    network_id       TEXT,
    from_area_id     TEXT,
    to_area_id       TEXT,
    from_timeframe_group_id TEXT,
    to_timeframe_group_id TEXT,
    fare_product_id  TEXT NOT NULL,
    rule_priority    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_lookup ON fare_leg_rules(feed_version_id, leg_group_id);

CREATE TABLE IF NOT EXISTS fare_leg_join_rules (
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    from_network_id  TEXT NOT NULL,
    to_network_id    TEXT NOT NULL,
    from_stop_id     TEXT,
    to_stop_id       TEXT,
    PRIMARY KEY (feed_version_id, from_network_id, to_network_id, from_stop_id, to_stop_id)
);

CREATE TABLE IF NOT EXISTS fare_transfer_rules (
    fare_transfer_rule_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    from_leg_group_id TEXT,
    to_leg_group_id   TEXT,
    transfer_count    INTEGER,
    duration_limit    INTEGER,
    duration_limit_type INTEGER,
    fare_transfer_type INTEGER NOT NULL,
    fare_product_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_lookup ON fare_transfer_rules(feed_version_id, from_leg_group_id, to_leg_group_id);


CREATE TABLE IF NOT EXISTS location_groups (
    location_group_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    location_group_id TEXT NOT NULL,
    location_group_name TEXT,
    UNIQUE(feed_version_id, location_group_id)
);

CREATE TABLE IF NOT EXISTS location_group_stops (
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    location_group_id TEXT NOT NULL,
    stop_id           TEXT NOT NULL,
    PRIMARY KEY (feed_version_id, location_group_id, stop_id)
);

CREATE TABLE IF NOT EXISTS booking_rules (
    booking_rule_pk   INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    booking_rule_id   TEXT NOT NULL,
    booking_type      INTEGER NOT NULL,
    prior_notice_duration_min INTEGER,
    prior_notice_duration_max INTEGER,
    prior_notice_last_day INTEGER,
    prior_notice_last_time INTEGER,
    prior_notice_start_day INTEGER,
    prior_notice_start_time INTEGER,
    prior_notice_service_id TEXT,
    message           TEXT,
    pickup_message    TEXT,
    drop_off_message  TEXT,
    phone_number      TEXT,
    info_url          TEXT,
    booking_url       TEXT,
    UNIQUE(feed_version_id, booking_rule_id)
);

CREATE TABLE IF NOT EXISTS translations (
    translation_pk   INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    table_name       TEXT NOT NULL,
    field_name       TEXT NOT NULL,
    language         TEXT NOT NULL,
    translation      TEXT NOT NULL,
    record_id        TEXT,
    record_sub_id    TEXT,
    field_value      TEXT
);

CREATE INDEX IF NOT EXISTS idx_translations_lookup ON translations(feed_version_id, table_name, field_name, language);

