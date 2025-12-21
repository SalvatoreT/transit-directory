# GTFS Database Design for Multi‑Agency Static + Realtime (SQLite / Cloudflare D1)

This document defines a **complete GTFS database schema** and a **step‑by‑step SQL plan** for storing:

- GTFS **static** feeds from **multiple agencies**
- GTFS‑Realtime (**vehicle positions**, **trip updates**, **service alerts**)

The target DB is **SQLite** (Cloudflare D1). The instructions are written so that another AI or automation can follow them deterministically.

---

## 0. Global Design Principles

1. **Multi‑agency and multi‑feed‑version aware**
   - Each _data publisher_ (usually an agency or regional feed) is a `feed_source`.
   - Each uploaded GTFS ZIP is a `feed_version` tied to a `feed_source`.
   - All static GTFS tables carry a `feed_version_id` so multiple versions can coexist.

2. **Preserve GTFS IDs + use integer surrogate keys**
   - Each GTFS entity keeps its original `*_id` (e.g. `route_id`, `trip_id`, `stop_id`).
   - Each table also has an integer primary key (`*_pk`) for fast joins.

3. **Static vs Realtime separation**
   - Static tables: schedule + topology (routes, stops, trips, stop_times, etc.).
   - Realtime tables: `vehicle_positions`, `trip_updates`, `service_alerts`.
   - Realtime records reference static data via `feed_source_id` and/or `feed_version_id` and static `*_pk` keys.

4. **Spatial support**
   - Stops and optionally vehicles/shapes store `lat`/`lon`.
   - If R\*Tree is available, we add virtual tables for spatial indexing; otherwise we rely on B‑tree indexes on `(lat, lon)`.

5. **Upserts for realtime**
   - Realtime tables are designed so that:
     - Primary key = logical entity (e.g., `(feed_source_id, vehicle_id)`).
     - New data uses `INSERT OR REPLACE` to overwrite previous state.

---

## 1. Core Metadata Tables

### 1.1 `feed_source`

Represents a logical data source (usually an agency or regional transit provider).

```sql
CREATE TABLE IF NOT EXISTS feed_source (
    feed_source_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name      TEXT NOT NULL,   -- e.g. "City Transit Authority"
    source_desc      TEXT,            -- human description
    default_lang     TEXT,            -- optional default language code (e.g. "en")
    UNIQUE(source_name)
);
```

**Usage notes**

- `feed_source_id` is the foreign key used from `feed_version` and realtime tables.
- You can pre‑seed this with known agencies, or create them on first import.

---

### 1.2 `feed_version`

Represents **one GTFS ZIP file** imported from a `feed_source`.

```sql
CREATE TABLE IF NOT EXISTS feed_version (
    feed_version_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id    INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    version_label     TEXT,        -- arbitrary label: "2025‑Spring‑v1" etc.
    date_added        TEXT NOT NULL DEFAULT (DATE('now')),
    feed_start_date   TEXT,        -- from feed_info or derived from calendar
    feed_end_date     TEXT,
    is_active         INTEGER NOT NULL DEFAULT 0,  -- 1 = currently active for this source
    UNIQUE(feed_source_id, version_label)
);
```

**AI implementation instructions**

- When importing a new GTFS ZIP for agency X:
  1. Ensure `feed_source` exists (insert if missing).
  2. Insert a new `feed_version` row with:
     - `feed_source_id` = that agency’s `feed_source_id`
     - `version_label` = some deterministic label (e.g., filename or timestamp)
     - `feed_start_date`/`feed_end_date` from `feed_info.txt` if present.
  3. Optionally set `is_active = 1` and set previous versions for this source to `0`.

---

### 1.3 `agency` (GTFS `agency.txt`)

```sql
CREATE TABLE IF NOT EXISTS agency (
    agency_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    agency_id       TEXT,        -- GTFS agency_id (may be NULL for single‑agency feeds)
    agency_name     TEXT NOT NULL,
    agency_url      TEXT NOT NULL,
    agency_timezone TEXT NOT NULL,
    agency_lang     TEXT,
    agency_phone    TEXT,
    agency_fare_url TEXT,
    agency_email    TEXT,
    UNIQUE(feed_version_id, agency_id)
);
```

**Notes**

- If GTFS omits `agency_id` (single‑agency feed), use `NULL` and ensure there’s only one agency row for that feed_version.
- Any table that references agency should reference `agency_pk` (fast integer FK).

---

### 1.4 `feed_info` (GTFS `feed_info.txt`)

One‑to‑one with `feed_version`.

```sql
CREATE TABLE IF NOT EXISTS feed_info (
    feed_version_id       INTEGER PRIMARY KEY REFERENCES feed_version(feed_version_id),
    feed_publisher_name   TEXT,
    feed_publisher_url    TEXT,
    feed_lang             TEXT,
    feed_version          TEXT,
    feed_start_date       TEXT,
    feed_end_date         TEXT,
    feed_contact_email    TEXT,
    feed_contact_url      TEXT
);
```

**AI instructions**

- When importing, if `feed_info.txt` exists, insert exactly one row referencing the current `feed_version_id`.
- If it doesn’t exist, you may leave this table empty for that version.

---

## 2. Core Static GTFS Tables

All of these tables **must** include `feed_version_id` and preserve the GTFS `*_id`.

### 2.1 `routes` (GTFS `routes.txt`)

```sql
CREATE TABLE IF NOT EXISTS routes (
    route_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id   INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    route_id          TEXT NOT NULL,          -- GTFS route_id
    agency_pk         INTEGER REFERENCES agency(agency_pk),
    route_short_name  TEXT,
    route_long_name   TEXT,
    route_desc        TEXT,
    route_type        INTEGER NOT NULL,       -- GTFS route_type
    route_url         TEXT,
    route_color       TEXT,
    route_text_color  TEXT,
    route_sort_order  INTEGER,
    continuous_pickup INTEGER,
    continuous_drop_off INTEGER,
    network_id        TEXT,
    UNIQUE(feed_version_id, route_id)
);
```

**Import order**

1. Import `agency` first.
2. For each row in `routes.txt`:
   - Map `agency_id` (if present) to `agency_pk`.
   - Insert a row with proper `feed_version_id`.

**Recommended indexes**

```sql
CREATE INDEX IF NOT EXISTS idx_routes_feed_version
    ON routes(feed_version_id);

CREATE INDEX IF NOT EXISTS idx_routes_agency
    ON routes(agency_pk);
```

---

### 2.2 `stops` (GTFS `stops.txt`)

```sql
CREATE TABLE IF NOT EXISTS stops (
    stop_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    stop_id          TEXT NOT NULL,       -- GTFS stop_id
    stop_code        TEXT,
    stop_name        TEXT NOT NULL,
    stop_desc        TEXT,
    stop_lat         REAL NOT NULL,
    stop_lon         REAL NOT NULL,
    zone_id          TEXT,
    stop_url         TEXT,
    location_type    INTEGER,            -- 0=stop, 1=station, etc.
    parent_station   INTEGER REFERENCES stops(stop_pk),
    stop_timezone    TEXT,
    wheelchair_boarding INTEGER,
    level_id         TEXT,               -- FK to levels.level_id (same feed_version)
    platform_code    TEXT,
    UNIQUE(feed_version_id, stop_id)
);
```

**Parent station resolution**

- Import all stops with `parent_station` temporarily as the **raw** GTFS `parent_station` string.
- After all stops are loaded:
  - For each stop where `parent_station IS NOT NULL` and is a string ID:
    1. Find the parent’s `stop_pk` using `(feed_version_id, stop_id)`.
    2. Update the child row to set `parent_station` to the parent’s `stop_pk`.

This can be implemented with a two‑pass load or with an in‑memory mapping.

**Spatial indexes (optional)**

If R\*Tree is available:

```sql
-- Virtual table for spatial indexing of stops
CREATE VIRTUAL TABLE IF NOT EXISTS stops_rtree
USING rtree(
    stop_pk,     -- must match stops.stop_pk
    min_lat, max_lat,
    min_lon, max_lon
);
```

After inserting a stop:

```sql
INSERT INTO stops_rtree (stop_pk, min_lat, max_lat, min_lon, max_lon)
VALUES (:stop_pk, :stop_lat, :stop_lat, :stop_lon, :stop_lon);
```

If R\*Tree is not available, at least create:

```sql
CREATE INDEX IF NOT EXISTS idx_stops_lat_lon
    ON stops(feed_version_id, stop_lat, stop_lon);
```

---

### 2.3 `calendar` (GTFS `calendar.txt`)

```sql
CREATE TABLE IF NOT EXISTS calendar (
    service_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    service_id      TEXT NOT NULL,  -- GTFS service_id
    monday          INTEGER NOT NULL,
    tuesday         INTEGER NOT NULL,
    wednesday       INTEGER NOT NULL,
    thursday        INTEGER NOT NULL,
    friday          INTEGER NOT NULL,
    saturday        INTEGER NOT NULL,
    sunday          INTEGER NOT NULL,
    start_date      TEXT NOT NULL,  -- "YYYYMMDD"
    end_date        TEXT NOT NULL,  -- "YYYYMMDD"
    UNIQUE(feed_version_id, service_id)
);
```

### 2.4 `calendar_dates` (GTFS `calendar_dates.txt`)

```sql
CREATE TABLE IF NOT EXISTS calendar_dates (
    caldate_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    service_id      TEXT NOT NULL,      -- references calendar.service_id or exists on its own
    date            TEXT NOT NULL,      -- "YYYYMMDD"
    exception_type  INTEGER NOT NULL    -- 1=added service, 2=removed service
);
```

**AI note**

- A `service_id` may appear only in `calendar_dates` (no row in `calendar`). This is valid; do not assume it must exist in `calendar`.

---

### 2.5 `trips` (GTFS `trips.txt`)

```sql
CREATE TABLE IF NOT EXISTS trips (
    trip_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    trip_id         TEXT NOT NULL,          -- GTFS trip_id
    route_pk        INTEGER NOT NULL REFERENCES routes(route_pk),
    service_id      TEXT NOT NULL,          -- GTFS service_id (matches calendar/calendar_dates)
    trip_headsign   TEXT,
    trip_short_name TEXT,
    direction_id    INTEGER,
    block_id        TEXT,
    shape_id        TEXT,                   -- GTFS shape_id (links to shapes table)
    wheelchair_accessible INTEGER,
    bikes_allowed   INTEGER,
    UNIQUE(feed_version_id, trip_id)
);
```

**Import order**

1. Import `routes`.
2. Import `calendar`/`calendar_dates`.
3. Import `trips`, mapping:
   - `route_id` → `route_pk` via `(feed_version_id, route_id)`.
   - `service_id` kept as text.

**Recommended indexes**

```sql
CREATE INDEX IF NOT EXISTS idx_trips_feed_version
    ON trips(feed_version_id);

CREATE INDEX IF NOT EXISTS idx_trips_route
    ON trips(route_pk);

CREATE INDEX IF NOT EXISTS idx_trips_service
    ON trips(feed_version_id, service_id);
```

---

### 2.6 `stop_times` (GTFS `stop_times.txt`)

```sql
CREATE TABLE IF NOT EXISTS stop_times (
    stop_time_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_pk          INTEGER NOT NULL REFERENCES trips(trip_pk),
    stop_pk          INTEGER NOT NULL REFERENCES stops(stop_pk),
    stop_sequence    INTEGER NOT NULL,
    arrival_time     TEXT,     -- "HH:MM:SS" or >24h syntax allowed; kept as TEXT
    departure_time   TEXT,
    stop_headsign    TEXT,
    pickup_type      INTEGER,
    drop_off_type    INTEGER,
    shape_dist_traveled REAL,
    timepoint        INTEGER,
    UNIQUE(trip_pk, stop_sequence)
);
```

**Indexes**

```sql
CREATE INDEX IF NOT EXISTS idx_stop_times_trip
    ON stop_times(trip_pk, stop_sequence);

CREATE INDEX IF NOT EXISTS idx_stop_times_stop
    ON stop_times(stop_pk, arrival_time);
```

**Import strategy**

- For each row in `stop_times.txt`:
  1. Map `trip_id` to `trip_pk` using `(feed_version_id, trip_id)`.
  2. Map `stop_id` to `stop_pk` using `(feed_version_id, stop_id)`.
  3. Insert one row per record.

---

### 2.7 `shapes` (GTFS `shapes.txt`) as `shape_points`

We model shapes as a points table.

```sql
CREATE TABLE IF NOT EXISTS shapes (
    shape_pt_pk        INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id    INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    shape_id           TEXT NOT NULL,        -- GTFS shape_id
    shape_pt_lat       REAL NOT NULL,
    shape_pt_lon       REAL NOT NULL,
    shape_pt_sequence  INTEGER NOT NULL,
    shape_dist_traveled REAL,
    UNIQUE(feed_version_id, shape_id, shape_pt_sequence)
);
```

**Indexes**

```sql
CREATE INDEX IF NOT EXISTS idx_shapes_id_seq
    ON shapes(feed_version_id, shape_id, shape_pt_sequence);
```

---

## 3. Optional Static GTFS Tables

### 3.1 `fare_attributes` (GTFS `fare_attributes.txt`)

```sql
CREATE TABLE IF NOT EXISTS fare_attributes (
    fare_pk          INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_id          TEXT NOT NULL,        -- GTFS fare_id
    price            REAL NOT NULL,
    currency_type    TEXT NOT NULL,
    payment_method   INTEGER NOT NULL,
    transfers        INTEGER,
    agency_pk        INTEGER REFERENCES agency(agency_pk),
    transfer_duration INTEGER,
    UNIQUE(feed_version_id, fare_id)
);
```

### 3.2 `fare_rules` (GTFS `fare_rules.txt`)

```sql
CREATE TABLE IF NOT EXISTS fare_rules (
    fare_rule_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    fare_id          TEXT NOT NULL,    -- references fare_attributes.fare_id
    route_id         TEXT,             -- GTFS route_id (optional)
    origin_id        TEXT,             -- zone_id (optional)
    destination_id   TEXT,             -- zone_id (optional)
    contains_id      TEXT              -- zone_id (optional)
    -- Use joins on route_id/zone_id when needed.
);
```

**AI note**

- `fare_id` is linked to `fare_attributes` through `(feed_version_id, fare_id)`.
- We keep the GTFS IDs as text, and can resolve to `route_pk`/zone semantics when needed.

---

### 3.3 `transfers` (GTFS `transfers.txt`)

We store FK references to `stops` via `stop_pk`.

```sql
CREATE TABLE IF NOT EXISTS transfers (
    transfer_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    from_stop_pk     INTEGER NOT NULL REFERENCES stops(stop_pk),
    to_stop_pk       INTEGER NOT NULL REFERENCES stops(stop_pk),
    transfer_type    INTEGER NOT NULL,
    min_transfer_time INTEGER
);
```

**Import strategy**

- For each row in `transfers.txt`:
  1. Map `from_stop_id` → `from_stop_pk` via `(feed_version_id, stop_id)`.
  2. Map `to_stop_id` → `to_stop_pk`.

---

### 3.4 `frequencies` (GTFS `frequencies.txt`)

```sql
CREATE TABLE IF NOT EXISTS frequencies (
    frequency_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_pk          INTEGER NOT NULL REFERENCES trips(trip_pk),
    start_time       TEXT NOT NULL,   -- HH:MM:SS
    end_time         TEXT NOT NULL,   -- HH:MM:SS
    headway_secs     INTEGER NOT NULL,
    exact_times      INTEGER          -- 0 or 1
);
```

---

### 3.5 `levels` (GTFS `levels.txt`)

```sql
CREATE TABLE IF NOT EXISTS levels (
    level_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id  INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    level_id         TEXT NOT NULL,        -- GTFS level_id
    level_index      REAL NOT NULL,
    level_name       TEXT,
    UNIQUE(feed_version_id, level_id)
);
```

**AI note**

- After importing `levels`, you can update `stops.level_id` string references to exactly match the `levels.level_id` field; typically no integer FK is required beyond that, but you could also add `level_pk` if needed.

---

### 3.6 `pathways` (GTFS `pathways.txt`)

```sql
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
```

**Import strategy**

- For each row, map `from_stop_id` and `to_stop_id` to `*_pk`.

---

### 3.7 `attributions` (GTFS `attributions.txt`)

```sql
CREATE TABLE IF NOT EXISTS attributions (
    attribution_pk       INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_version_id      INTEGER NOT NULL REFERENCES feed_version(feed_version_id),
    attribution_id       TEXT,   -- optional GTFS attribution_id
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
```

---

## 4. Realtime Tables

Realtime tables are **logically separate** but tied to `feed_source` and static entities.

### 4.1 `vehicle_positions` (GTFS‑Realtime VehiclePosition)

```sql
CREATE TABLE IF NOT EXISTS vehicle_positions (
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    vehicle_id       TEXT   NOT NULL,      -- GTFS‑RT vehicle.id or label
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    route_pk         INTEGER REFERENCES routes(route_pk),
    latitude         REAL,
    longitude        REAL,
    speed            REAL,                 -- m/s or consistent unit
    heading          REAL,                 -- degrees 0‑359
    timestamp        TEXT NOT NULL,        -- ISO8601 or UNIX seconds as TEXT
    current_status   TEXT,                 -- e.g. "IN_TRANSIT", "STOPPED_AT"
    occupancy_status TEXT,                 -- e.g. "MANY_SEATS_AVAILABLE"
    PRIMARY KEY (feed_source_id, vehicle_id)
);
```

**AI update algorithm**

For each GTFS‑RT vehicle entity:

1. Determine `feed_source_id` (based on config).
2. Map GTFS‑RT `trip_id` (if present) to `trip_pk`:
   - Query active `feed_version` for this `feed_source_id`:
     ```sql
     SELECT feed_version_id
     FROM feed_version
     WHERE feed_source_id = :source
       AND is_active = 1;
     ```
   - Then map `trip_id` to `trip_pk`:
     ```sql
     SELECT trip_pk
     FROM trips
     WHERE feed_version_id = :feed_version_id
       AND trip_id = :gtfs_trip_id;
     ```
3. Map `route_id` if provided similarly to `route_pk`.
4. UPSERT:

```sql
INSERT OR REPLACE INTO vehicle_positions (
    feed_source_id, vehicle_id, trip_pk, route_pk,
    latitude, longitude, speed, heading, timestamp,
    current_status, occupancy_status
) VALUES (
    :feed_source_id, :vehicle_id, :trip_pk, :route_pk,
    :lat, :lon, :speed, :heading, :timestamp,
    :current_status, :occupancy_status
);
```

**Optional spatial index**

If available:

```sql
CREATE INDEX IF NOT EXISTS idx_vehicle_positions_route
    ON vehicle_positions(feed_source_id, route_pk);
```

And optionally:

```sql
CREATE INDEX IF NOT EXISTS idx_vehicle_positions_lat_lon
    ON vehicle_positions(feed_source_id, latitude, longitude);
```

---

### 4.2 `trip_updates` (GTFS‑Realtime TripUpdate)

```sql
CREATE TABLE IF NOT EXISTS trip_updates (
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    trip_id          TEXT NOT NULL,           -- GTFS trip_id
    trip_pk          INTEGER REFERENCES trips(trip_pk),
    delay            INTEGER,                 -- seconds (positive = late)
    status           TEXT,                    -- e.g. "ON_TIME", "DELAYED", "CANCELED"
    updated_time     TEXT NOT NULL,           -- ISO8601 or UNIX seconds as TEXT
    PRIMARY KEY (feed_source_id, trip_id)
);
```

**AI update algorithm**

For each GTFS‑RT TripUpdate:

1. Resolve active `feed_version_id` for the `feed_source_id`.
2. Resolve `trip_pk` similarly to vehicle_positions.
3. Compute a representative `delay`:
   - If there’s a `delay` at the trip or first StopTimeUpdate, use it.
   - If unavailable, can be `NULL`.
4. Set `status` based on `schedule_relationship` (if `CANCELED`, set `"CANCELED"`, etc.).
5. UPSERT:

```sql
INSERT OR REPLACE INTO trip_updates (
    feed_source_id, trip_id, trip_pk, delay, status, updated_time
) VALUES (
    :feed_source_id, :trip_id, :trip_pk, :delay, :status, :updated_time
);
```

**Cleanup**

- Periodically delete very old trip_updates:

```sql
DELETE FROM trip_updates
WHERE updated_time < DATETIME('now', '-2 days');
```

(adjust the retention as needed).

---

### 4.3 `service_alerts` (GTFS‑Realtime Alert)

Simplified schema (one row per alert). More complex many‑to‑many mappings can be added if needed.

```sql
CREATE TABLE IF NOT EXISTS service_alerts (
    alert_pk         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id   INTEGER NOT NULL REFERENCES feed_source(feed_source_id),
    alert_id         TEXT,          -- GTFS‑RT alert.id if present
    header           TEXT,
    description      TEXT,
    cause            TEXT,
    effect           TEXT,
    start_time       TEXT,
    end_time         TEXT,
    severity_level   TEXT,
    affected_route_pk   INTEGER REFERENCES routes(route_pk),
    affected_stop_pk    INTEGER REFERENCES stops(stop_pk),
    affected_trip_pk    INTEGER REFERENCES trips(trip_pk)
);
```

**AI update strategy (simple)**

- On each GTFS‑RT Alerts poll for a given `feed_source_id`:
  1. Delete all existing alerts for that feed_source:
     ```sql
     DELETE FROM service_alerts WHERE feed_source_id = :feed_source_id;
     ```
  2. Insert one row per current alert with mapped route/stop/trip if possible.

Alternate strategy: if the feed provides stable `alert_id`, you can `INSERT OR REPLACE` keyed by `(feed_source_id, alert_id)` via a UNIQUE constraint.

---

## 5. Import Workflow for Static GTFS Feeds

This is the exact **order** recommended when importing a new `feed_version`. Another AI can follow these steps:

### 5.1 Determine / create `feed_source`

1. Given a GTFS ZIP and an external config (e.g. `"City Transit"`):
   - Query `feed_source` for `source_name`.
   - If no row exists, `INSERT` a new one and record `feed_source_id`.

### 5.2 Create `feed_version`

2. Insert one row into `feed_version`:

```sql
INSERT INTO feed_version (feed_source_id, version_label, date_added, feed_start_date, feed_end_date, is_active)
VALUES (:feed_source_id, :version_label, DATE('now'), :feed_start_date, :feed_end_date, 0);
```

3. Get the new `feed_version_id` using `last_insert_rowid()`.

4. Optionally set this new version as active:

```sql
UPDATE feed_version
SET is_active = 0
WHERE feed_source_id = :feed_source_id;

UPDATE feed_version
SET is_active = 1
WHERE feed_version_id = :feed_version_id;
```

### 5.3 Table import order

For each GTFS file present in the ZIP, perform these steps **in this exact order**:

1. **`agency.txt` → `agency`**
2. **`stops.txt` → `stops`**
3. **`levels.txt` → `levels`** (if present; can be before or after stops)
4. **`routes.txt` → `routes`**
5. **`calendar.txt` → `calendar`** (if present)
6. **`calendar_dates.txt` → `calendar_dates`** (if present)
7. **`trips.txt` → `trips`**
8. **`stop_times.txt` → `stop_times`**
9. **`shapes.txt` → `shapes`**
10. **`fare_attributes.txt` → `fare_attributes`**
11. **`fare_rules.txt` → `fare_rules`**
12. **`transfers.txt` → `transfers`**
13. **`pathways.txt` → `pathways`**
14. **`frequencies.txt` → `frequencies`**
15. **`attributions.txt` → `attributions`**
16. **`feed_info.txt` → `feed_info`**

### 5.4 Parent linking cleanups

After all raw inserts:

1. **Stops parent_station**

```sql
-- Example: update stops.parent_station from raw parent stop_id to parent stop_pk
UPDATE stops AS child
SET parent_station = parent.stop_pk
FROM stops AS parent
WHERE child.feed_version_id = :feed_version_id
  AND parent.feed_version_id = :feed_version_id
  AND child.parent_station IS NOT NULL
  AND child.parent_station = parent.stop_id;
```

_(If your SQLite dialect doesn’t support `UPDATE ... FROM`, perform this with a temporary table or with multiple queries.)_

2. **Pathways / Transfers**: if you temporarily stored raw `from_stop_id`/`to_stop_id`, convert them to `*_pk` with similar updates.

---

## 6. Example Queries

### 6.1 Next departures at a stop (with realtime delay)

Given:

- `feed_source_id = :source`
- Want the active `feed_version_id`
- GTFS `stop_id = :stop_id`
- Current time string `:now_time` in `HH:MM:SS` for schedule comparison
- Current date `:today` in `YYYYMMDD`

**Step 1: Find active feed_version_id**

```sql
SELECT feed_version_id
FROM feed_version
WHERE feed_source_id = :source
  AND is_active = 1;
```

**Step 2: Get upcoming trips**

```sql
SELECT
    r.route_short_name,
    t.trip_headsign,
    st.departure_time,
    tu.delay
FROM stops s
JOIN stop_times st   ON s.stop_pk = st.stop_pk
JOIN trips t         ON st.trip_pk = t.trip_pk
JOIN routes r        ON t.route_pk = r.route_pk
LEFT JOIN trip_updates tu
    ON tu.feed_source_id = :source
   AND tu.trip_id = t.trip_id
WHERE s.feed_version_id = :feed_version_id
  AND s.stop_id = :stop_id
  AND st.departure_time > :now_time
  AND t.feed_version_id = s.feed_version_id
  AND r.feed_version_id = s.feed_version_id
  -- Check that service runs today via calendar:
  AND (
        EXISTS (
            SELECT 1
            FROM calendar c
            WHERE c.feed_version_id = s.feed_version_id
              AND c.service_id = t.service_id
              AND c.start_date <= :today
              AND c.end_date   >= :today
              AND (
                   (strftime('%w', :today_sqlite) = '1' AND c.monday   = 1) OR
                   (strftime('%w', :today_sqlite) = '2' AND c.tuesday  = 1) OR
                   (strftime('%w', :today_sqlite) = '3' AND c.wednesday= 1) OR
                   (strftime('%w', :today_sqlite) = '4' AND c.thursday = 1) OR
                   (strftime('%w', :today_sqlite) = '5' AND c.friday   = 1) OR
                   (strftime('%w', :today_sqlite) = '6' AND c.saturday = 1) OR
                   (strftime('%w', :today_sqlite) = '0' AND c.sunday   = 1)
                  )
        )
        OR EXISTS (
            SELECT 1
            FROM calendar_dates cd
            WHERE cd.feed_version_id = s.feed_version_id
              AND cd.service_id      = t.service_id
              AND cd.date            = :today
              AND cd.exception_type  = 1
        )
      )
  AND NOT EXISTS (
        SELECT 1
        FROM calendar_dates cd
        WHERE cd.feed_version_id = s.feed_version_id
          AND cd.service_id      = t.service_id
          AND cd.date            = :today
          AND cd.exception_type  = 2
      )
ORDER BY st.departure_time
LIMIT 5;
```

**Notes for AI**

- `:today` should be `YYYYMMDD`.
- `:today_sqlite` can be `DATE('now')` or equivalent; adjust binding accordingly.
- Add `tu.delay` (seconds) to `departure_time` on the client/UI side to get predicted departure.

---

### 6.2 Nearby stops for a given coordinate

If R\*Tree is **not** available:

```sql
SELECT stop_name, stop_id, stop_lat, stop_lon
FROM stops
WHERE feed_version_id = :feed_version_id
  AND stop_lat BETWEEN :lat_min AND :lat_max
  AND stop_lon BETWEEN :lon_min AND :lon_max;
```

Where:

- `:lat_min = :lat_center - delta`
- `:lat_max = :lat_center + delta`
- `:lon_min = :lon_center - delta`
- `:lon_max = :lon_center + delta`

Use `delta ≈ 0.005` for ~500m.

If R\*Tree **is** available:

```sql
SELECT s.stop_name, s.stop_id, s.stop_lat, s.stop_lon
FROM stops s
JOIN stops_rtree sr ON s.stop_pk = sr.stop_pk
WHERE s.feed_version_id = :feed_version_id
  AND sr.min_lat >= :lat_min
  AND sr.max_lat <= :lat_max
  AND sr.min_lon >= :lon_min
  AND sr.max_lon <= :lon_max;
```

---

### 6.3 Active vehicles on a route

```sql
SELECT
    v.vehicle_id,
    v.latitude,
    v.longitude,
    v.timestamp,
    t.trip_headsign,
    tu.delay
FROM feed_version fv
JOIN routes r
    ON fv.feed_version_id = r.feed_version_id
JOIN trips t
    ON t.route_pk = r.route_pk
   AND t.feed_version_id = fv.feed_version_id
JOIN vehicle_positions v
    ON v.trip_pk = t.trip_pk
   AND v.feed_source_id = fv.feed_source_id
LEFT JOIN trip_updates tu
    ON tu.feed_source_id = v.feed_source_id
   AND tu.trip_id        = t.trip_id
WHERE fv.feed_source_id = :feed_source_id
  AND fv.is_active = 1
  AND r.route_short_name = :route_short_name;
```

---

## 7. Maintenance and Cleanup

### 7.1 Realtime data retention

Example cleanup jobs:

```sql
-- Remove vehicle positions older than 2 hours
DELETE FROM vehicle_positions
WHERE timestamp < DATETIME('now', '-2 hours');

-- Remove trip updates older than 2 days
DELETE FROM trip_updates
WHERE updated_time < DATETIME('now', '-2 days');
```

### 7.2 Deleting old feed versions (optional)

To fully drop a deprecated feed_version:

1. Ensure it is not active.
2. Delete child rows in the correct dependency order.
3. Finally delete `feed_version`.

Example (simplified):

```sql
DELETE FROM attributions     WHERE feed_version_id = :fv;
DELETE FROM pathways         WHERE feed_version_id = :fv;
DELETE FROM transfers        WHERE feed_version_id = :fv;
DELETE FROM fare_rules       WHERE feed_version_id = :fv;
DELETE FROM fare_attributes  WHERE feed_version_id = :fv;
DELETE FROM shapes           WHERE feed_version_id = :fv;
DELETE FROM stop_times       WHERE trip_pk IN (
    SELECT trip_pk FROM trips WHERE feed_version_id = :fv
);
DELETE FROM trips            WHERE feed_version_id = :fv;
DELETE FROM calendar_dates   WHERE feed_version_id = :fv;
DELETE FROM calendar         WHERE feed_version_id = :fv;
DELETE FROM routes           WHERE feed_version_id = :fv;
DELETE FROM stops            WHERE feed_version_id = :fv;
DELETE FROM levels           WHERE feed_version_id = :fv;
DELETE FROM agency           WHERE feed_version_id = :fv;
DELETE FROM feed_info        WHERE feed_version_id = :fv;
DELETE FROM feed_version     WHERE feed_version_id = :fv;
```

_(If you enable `ON DELETE CASCADE` on all relevant foreign keys, many of these explicit deletes can be replaced by a single `DELETE FROM feed_version`.)_

---

## 8. Summary

- This schema is **GTFS‑complete** (static + realtime) and **multi‑agency**.
- Static data is versioned via `feed_version`.
- Realtime data is keyed by `feed_source` and upserted using `INSERT OR REPLACE`.
- Spatial queries are supported via lat/lon columns and optionally R\*Tree virtual tables.
- The import and query recipes in this document are written to be straightforward for another AI or automated system to follow step‑by‑step.
