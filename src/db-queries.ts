// Pure SQL builders, realtime-merge helpers, and constants shared by
// src/db.ts.
//
// This module must not import "cloudflare:workers" (directly or transitively)
// so it stays loadable in vitest for unit tests.

import { extractTripUpdateState } from "./realtime-utils";
import type { transit_realtime } from "./gtfs-realtime";

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
  limit?: number;
}

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

// Per-trip realtime state, keyed by static (prefix-stripped) trip_id. Built
// from the on-demand GTFS-RT feed and merged into query results in JS, so the
// SQL stays a pure static-schedule read.
export interface RealtimeEntry {
  delay: number;
  status: string;
}

// Reduces a decoded GTFS-Realtime feed to a trip_id -> {delay, status} map.
// Keys are prefix-stripped to match static GTFS trip ids (see
// extractTripUpdateState). Later entities win on duplicate trip ids.
export function buildRealtimeMap(
  entities: transit_realtime.IFeedEntity[],
): Map<string, RealtimeEntry> {
  const map = new Map<string, RealtimeEntry>();
  for (const entity of entities) {
    const state = extractTripUpdateState(entity);
    if (state) {
      map.set(state.tripId, { delay: state.delay, status: state.status });
    }
  }
  return map;
}

// Attaches realtime delay/status to departure rows by trip_id. Rows without a
// matching realtime entry keep null fields (rendered as scheduled).
export function mergeDeparturesRealtime<T extends { trip_id: string }>(
  rows: T[],
  rt: Map<string, RealtimeEntry>,
): (T & { delay: number | null; realtime_status: string | null })[] {
  return rows.map((row) => {
    const hit = rt.get(row.trip_id);
    return {
      ...row,
      delay: hit ? hit.delay : null,
      realtime_status: hit ? hit.status : null,
    };
  });
}

// A trip page renders one trip, so every stop row shares that trip's single
// realtime delay (matching the old trip_pk-only join).
export function mergeTripStopsRealtime<T>(
  rows: T[],
  tripId: string,
  rt: Map<string, RealtimeEntry>,
): (T & { delay: number | null })[] {
  const hit = rt.get(tripId);
  const delay = hit ? hit.delay : null;
  return rows.map((row) => ({ ...row, delay }));
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
    limit,
  } = filter;

  if (!DAY_COLUMNS.includes(todayColumn as (typeof DAY_COLUMNS)[number])) {
    throw new Error(`Invalid calendar day column: ${todayColumn}`);
  }

  const conditions: string[] = ["s.feed_version_id = ?"];
  const params: unknown[] = [feed_version_id];

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

  // Realtime delay/status are merged in JS afterward (see
  // mergeDeparturesRealtime); this query is a pure static-schedule read.
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
        st.stop_sequence
    FROM stop_times st
    JOIN stops s ON st.stop_pk = s.stop_pk
    JOIN trips t ON st.trip_pk = t.trip_pk
    JOIN routes r ON t.route_pk = r.route_pk
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

export function buildTripStopsQuery(tripPk: number): SqlQuery {
  // Realtime delay is merged in JS afterward (see mergeTripStopsRealtime).
  const sql = `
    SELECT
        ${columnList(STOP_COLUMNS, "s")},
        st.arrival_time,
        st.departure_time,
        st.stop_sequence,
        st.timepoint,
        st.pickup_type,
        st.drop_off_type
    FROM stops s
    JOIN stop_times st ON s.stop_pk = st.stop_pk
    WHERE st.trip_pk = ?
    ORDER BY st.stop_sequence ASC
    LIMIT ${TRIP_STOPS_LIMIT}
  `;
  return {
    sql,
    params: [tripPk],
  };
}
