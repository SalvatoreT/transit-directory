// Pure SQL builders for deleting old, inactive feed versions and stale
// realtime rows. Kept free of "cloudflare:workers" imports so the ordering
// logic is unit-testable with vitest.
//
// Inactive feed versions were previously only flagged (is_active = 0) and
// never deleted, so every feed change permanently grew D1 storage by a full
// copy of the feed (stop_times alone is millions of rows). These statements
// reclaim that storage once a version has aged out of its rollback window.

// How long a deactivated version is kept for manual rollback before its data
// is deleted. Tunable.
export const VERSION_RETENTION_SECONDS = 7 * 24 * 3600;

// trip_updates rows older than this are purged by the daily import; the read
// path already ignores anything older than REALTIME_STALENESS_SECONDS.
// Tunable.
export const TRIP_UPDATES_RETENTION_SECONDS = 24 * 3600;

// Rows deleted per batched statement. Keeps each query comfortably under
// D1's per-query execution limits (see migration 0014's note about dropping
// multi-million-row tables in one statement).
export const CLEANUP_BATCH_SIZE = 5000;

export interface CleanupStatement {
  table: string;
  // ?1 binds feed_version_id; batched statements also bind ?2 = batch size.
  sql: string;
  // Batched statements are re-run until they affect 0 rows.
  batched: boolean;
}

function deleteAll(table: string): CleanupStatement {
  return {
    table,
    sql: `DELETE FROM ${table} WHERE feed_version_id = ?1`,
    batched: false,
  };
}

function deleteBatchedByPk(table: string, pkColumn: string): CleanupStatement {
  return {
    table,
    sql: `DELETE FROM ${table} WHERE ${pkColumn} IN (SELECT ${pkColumn} FROM ${table} WHERE feed_version_id = ?1 LIMIT ?2)`,
    batched: true,
  };
}

// Statements that fully remove one feed version, ordered so foreign key
// constraints (enforced by D1) are never violated: referencing rows are
// always removed or detached before the rows they point at.
export function buildVersionCleanupStatements(): CleanupStatement[] {
  return [
    // Realtime rows outlive feed versions; detach them from this version's
    // trips before the trips go away.
    {
      table: "trip_updates",
      sql: "UPDATE trip_updates SET trip_pk = NULL WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?1)",
      batched: false,
    },

    // References trips + stops; by far the largest table, so batched.
    {
      table: "stop_times",
      sql: "DELETE FROM stop_times WHERE stop_time_pk IN (SELECT st.stop_time_pk FROM stop_times st JOIN trips t ON st.trip_pk = t.trip_pk WHERE t.feed_version_id = ?1 LIMIT ?2)",
      batched: true,
    },

    // References trips.
    {
      table: "frequencies",
      sql: "DELETE FROM frequencies WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?1)",
      batched: false,
    },

    // Reference stops/routes/trips/agency.
    deleteAll("transfers"),
    deleteAll("attributions"),
    deleteAll("pathways"),

    // References routes; sizable, so batched.
    deleteBatchedByPk("trips", "trip_pk"),

    // stops self-reference via parent_station, so detach children before
    // batched deletion can remove parents.
    {
      table: "stops",
      sql: "UPDATE stops SET parent_station = NULL WHERE feed_version_id = ?1 AND parent_station IS NOT NULL",
      batched: false,
    },
    deleteBatchedByPk("stops", "stop_pk"),

    // Sizable, feed_version-scoped.
    deleteBatchedByPk("shapes", "shape_pt_pk"),

    // feed_version-scoped tables (fare_attributes also references agency,
    // so all of these go before routes/agency).
    deleteAll("fare_rules"),
    deleteAll("fare_attributes"),
    deleteAll("fare_leg_join_rules"),
    deleteAll("fare_transfer_rules"),
    deleteAll("fare_leg_rules"),
    deleteAll("fare_products"),
    deleteAll("fare_media"),
    deleteAll("rider_categories"),
    deleteAll("route_networks"),
    deleteAll("networks"),
    deleteAll("timeframes"),
    deleteAll("stop_areas"),
    deleteAll("areas"),
    deleteAll("location_group_stops"),
    deleteAll("location_groups"),
    deleteAll("booking_rules"),
    deleteAll("translations"),
    deleteAll("calendar_dates"),
    deleteAll("calendar"),
    deleteAll("levels"),
    deleteAll("feed_info"),

    // References agency.
    deleteAll("routes"),
    deleteAll("agency"),

    // Finally the version row itself.
    {
      table: "feed_version",
      sql: "DELETE FROM feed_version WHERE feed_version_id = ?1",
      batched: false,
    },
  ];
}

// COALESCE covers versions that never got a deactivated_at stamp (e.g. a
// crashed import that was never activated): their date_added starts the
// clock instead.
export function buildCondemnedVersionsQuery(): string {
  return `SELECT feed_version_id FROM feed_version WHERE feed_source_id = ?1 AND is_active = 0 AND COALESCE(deactivated_at, date_added) < unixepoch() - ${VERSION_RETENTION_SECONDS}`;
}

export function buildTripUpdatesPurgeQuery(): string {
  return `DELETE FROM trip_updates WHERE updated_time < unixepoch() - ${TRIP_UPDATES_RETENTION_SECONDS}`;
}
