// Pure SQL builders and constants shared by src/db.ts.
//
// This module must not import "cloudflare:workers" (directly or transitively)
// so it stays loadable in vitest for unit tests.

// How old a trip_updates row may be and still render as live data. Realtime
// polls land every ~15-65s; 15 minutes covers rate-limit gaps without
// resurrecting yesterday's delays.
export const REALTIME_STALENESS_SECONDS = 900;

// Hard caps so a single page view cannot scan unbounded result sets. The
// queries are ordered, so caps only ever drop the furthest-out rows, which
// the UIs never render anyway.
export const TRIP_STOPS_LIMIT = 500;
export const ROUTE_STOPS_LIMIT = 1000;

// Explicit column lists matching the exported interfaces in src/db.ts.
// Projecting columns (instead of SELECT *) keeps row width stable as
// migrations add columns and trims rows-read transfer/CPU.
export const AGENCY_COLUMNS = [
  "agency_pk",
  "agency_id",
  "agency_name",
  "agency_timezone",
  "feed_version_id",
] as const;

export const STOP_COLUMNS = [
  "stop_pk",
  "stop_id",
  "stop_code",
  "stop_name",
  "stop_desc",
  "stop_lat",
  "stop_lon",
  "zone_id",
  "stop_url",
  "location_type",
  "parent_station",
  "stop_timezone",
  "wheelchair_boarding",
  "level_id",
  "platform_code",
  "feed_version_id",
] as const;

export const ROUTE_COLUMNS = [
  "route_pk",
  "route_id",
  "agency_pk",
  "feed_version_id",
  "route_short_name",
  "route_long_name",
  "route_desc",
  "route_type",
  "route_url",
  "route_color",
  "route_text_color",
  "route_sort_order",
] as const;

export const TRIP_COLUMNS = [
  "trip_pk",
  "feed_version_id",
  "trip_id",
  "route_pk",
  "service_id",
  "trip_headsign",
  "trip_short_name",
  "direction_id",
  "block_id",
  "shape_id",
  "wheelchair_accessible",
  "bikes_allowed",
] as const;

export function columnList(columns: readonly string[], alias?: string): string {
  return columns.map((c) => (alias ? `${alias}.${c}` : c)).join(", ");
}

// calendar weekday columns; todayColumn is interpolated into SQL, so it must
// come from this list.
const DAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export interface DeparturesFilter {
  feed_version_id: number;
  stopPks?: number[];
  route_pk?: number;
  currentSeconds: number;
  endSeconds: number;
  todayNoon: number;
  todayColumn: string;
  // Unix seconds; realtime rows older than nowEpochSeconds -
  // REALTIME_STALENESS_SECONDS are ignored rather than shown as live.
  nowEpochSeconds: number;
  limit?: number;
}

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

export function buildDeparturesQuery(filter: DeparturesFilter): SqlQuery {
  const {
    feed_version_id,
    stopPks,
    route_pk,
    currentSeconds,
    endSeconds,
    todayNoon,
    todayColumn,
    nowEpochSeconds,
    limit,
  } = filter;

  if (!DAY_COLUMNS.includes(todayColumn as (typeof DAY_COLUMNS)[number])) {
    throw new Error(`Invalid calendar day column: ${todayColumn}`);
  }

  const conditions: string[] = ["s.feed_version_id = ?"];
  // The trip_updates join condition binds first (it appears before WHERE in
  // the statement text).
  const params: unknown[] = [
    nowEpochSeconds - REALTIME_STALENESS_SECONDS,
    feed_version_id,
  ];

  if (stopPks && stopPks.length > 0) {
    const placeholders = stopPks.map(() => "?").join(",");
    conditions.push(`s.stop_pk IN (${placeholders})`);
    params.push(...stopPks);
  }

  if (route_pk !== undefined) {
    conditions.push("r.route_pk = ?");
    params.push(route_pk);
  }

  params.push(currentSeconds, endSeconds);
  params.push(todayNoon, todayNoon, todayNoon, todayNoon);

  // trip_pk is a globally unique surrogate key, so the realtime join can
  // only match the exact trips row each update was written for; rows still
  // pointing at deactivated feed versions never join. Only freshness needs
  // filtering here.
  let sql = `
    SELECT
        s.stop_pk,
        s.stop_id,
        r.route_id,
        t.trip_id,
        r.route_short_name,
        r.route_long_name,
        r.route_color,
        r.route_text_color,
        t.trip_headsign,
        st.departure_time,
        st.stop_sequence,
        tu.delay,
        tu.status as realtime_status
    FROM stop_times st
    JOIN stops s ON st.stop_pk = s.stop_pk
    JOIN trips t ON st.trip_pk = t.trip_pk
    JOIN routes r ON t.route_pk = r.route_pk
    LEFT JOIN trip_updates tu ON tu.trip_pk = t.trip_pk
      AND tu.updated_time >= ?
    WHERE ${conditions.join(" AND ")}
      AND st.departure_time >= ?
      AND st.departure_time <= ?
      AND (
        EXISTS (
            SELECT 1 FROM calendar c
            WHERE c.feed_version_id = s.feed_version_id
              AND c.service_id = t.service_id
              AND c.start_date <= ?
              AND c.end_date >= ?
              AND c.${todayColumn} = 1
        )
        OR EXISTS (
            SELECT 1 FROM calendar_dates cd
            WHERE cd.feed_version_id = s.feed_version_id
              AND cd.service_id = t.service_id
              AND cd.date = ?
              AND cd.exception_type = 1
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM calendar_dates cd
        WHERE cd.feed_version_id = s.feed_version_id
          AND cd.service_id = t.service_id
          AND cd.date = ?
          AND cd.exception_type = 2
      )
    ORDER BY st.departure_time ASC
  `;

  if (limit !== undefined) {
    sql += "    LIMIT ?\n";
    params.push(limit);
  }

  return { sql, params };
}

export function buildTripStopsQuery(
  tripPk: number,
  nowEpochSeconds: number,
): SqlQuery {
  const sql = `
    SELECT
        ${columnList(STOP_COLUMNS, "s")},
        st.arrival_time,
        st.departure_time,
        st.stop_sequence,
        st.timepoint,
        st.pickup_type,
        st.drop_off_type,
        tu.delay
    FROM stops s
    JOIN stop_times st ON s.stop_pk = st.stop_pk
    LEFT JOIN trip_updates tu ON tu.trip_pk = st.trip_pk
      AND tu.updated_time >= ?
    WHERE st.trip_pk = ?
    ORDER BY st.stop_sequence ASC
    LIMIT ${TRIP_STOPS_LIMIT}
  `;
  return {
    sql,
    params: [nowEpochSeconds - REALTIME_STALENESS_SECONDS, tripPk],
  };
}
