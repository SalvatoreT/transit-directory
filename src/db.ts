import { env } from "cloudflare:workers";
import { cache } from "react";
import {
  AGENCY_COLUMNS,
  ROUTE_COLUMNS,
  ROUTE_STOPS_SQL,
  STOP_COLUMNS,
  TRIP_COLUMNS,
  buildDeparturesQuery,
  buildTripStopsQuery,
  columnList,
  mergeDeparturesRealtime,
  mergeTripStopsRealtime,
  type DeparturesFilter,
} from "./db-queries";
import {
  getRealtimeSnapshot,
  getRealtimeTripUpdates,
  type RealtimeFeedStatus,
} from "./realtime-feed";

export type { DeparturesFilter } from "./db-queries";

// Types
export interface AgenciesData {
  agency_name: string;
  agency_id: string;
  agency_pk: number;
  agency_timezone: string;
  feed_version_id: number;
}

export interface StopsData {
  stop_pk: number;
  stop_id: string;
  stop_code: string | null;
  stop_name: string;
  stop_desc: string | null;
  stop_lat: number;
  stop_lon: number;
  zone_id: string | null;
  stop_url: string | null;
  location_type: number | null;
  parent_station: number | null;
  stop_timezone: string | null;
  wheelchair_boarding: number | null;
  level_id: string | null;
  platform_code: string | null;
  feed_version_id: number;
}

export interface RoutesData {
  route_pk: number;
  route_id: string;
  agency_pk: number | null;
  feed_version_id: number;
  route_short_name: string | null;
  route_long_name: string | null;
  route_desc: string | null;
  route_type: number;
  route_url: string | null;
  route_color: string | null;
  route_text_color: string | null;
  route_sort_order: number | null;
}

export interface DeparturesData {
  stop_pk: number;
  stop_id: string;
  route_id: string;
  trip_id: string;
  direction_id: number | null;
  route_short_name: string | null;
  route_long_name: string | null;
  route_color: string | null;
  route_text_color: string | null;
  trip_headsign: string | null;
  arrival_time: number | null;
  departure_time: number;
  stop_sequence: number;
  delay: number | null;
  realtime_status: string | null;
}

export interface TripData {
  trip_pk: number;
  feed_version_id: number;
  trip_id: string;
  route_pk: number;
  service_id: string;
  trip_headsign: string | null;
  trip_short_name: string | null;
  direction_id: number | null;
  block_id: string | null;
  shape_id: string | null;
  wheelchair_accessible: number | null;
  bikes_allowed: number | null;
}

export interface RouteStopData extends StopsData {
  direction_id: number | null;
  stop_sequence: number;
  trip_headsign: string | null;
}

export interface TripStopData extends StopsData {
  arrival_time: number | null;
  departure_time: number | null;
  stop_sequence: number;
  timepoint: number | null;
  pickup_type: number | null;
  drop_off_type: number | null;
  delay: number | null;
  departure_delay: number | null;
  realtime_status: string | null;
}

export interface StopsFilter {
  feed_version_id: number;
  is_parent?: boolean;
  parent_station_pk?: number;
}

export interface RoutesFilter {
  feed_version_id: number;
  agency_pk?: number;
}

function getDb() {
  const db = (env as any).gtfs_data as D1Database;
  return db.withSession("first-unconstrained");
}

// Single-row getters with primitive arguments are wrapped in React cache()
// so generateMetadata and the page body share one D1 read per request.
// (cache() keys by argument identity, so the object-filter getters below
// would never hit and stay unwrapped.)

export const getAgencies = cache(async (): Promise<AgenciesData[]> => {
  const result = await getDb()
    .prepare(
      `SELECT ${columnList(AGENCY_COLUMNS, "a")} FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id WHERE fv.is_active = 1`,
    )
    .all<AgenciesData>();
  return result.results;
});

export async function getSitemapRoutes() {
  const result = await getDb()
    .prepare(
      `
    SELECT a.agency_pk, a.agency_id, r.route_id
    FROM agency a
    JOIN feed_version fv ON fv.feed_version_id = a.feed_version_id
    LEFT JOIN routes r ON r.agency_pk = a.agency_pk AND r.feed_version_id = a.feed_version_id
    WHERE fv.is_active = 1
    ORDER BY a.agency_pk, r.route_sort_order, r.route_short_name, r.route_pk
  `,
    )
    .all<{ agency_pk: number; agency_id: string; route_id: string | null }>();
  return result.results;
}

type AgencyWithSource = AgenciesData & { source_name: string };

export const getAgency = cache(
  async (agencyId: string): Promise<AgencyWithSource | null> => {
    const result = await getDb()
      .prepare(
        `SELECT ${columnList(AGENCY_COLUMNS, "a")}, fs.source_name FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id JOIN feed_source fs ON fs.feed_source_id = fv.feed_source_id WHERE a.agency_id = ? AND fv.is_active = 1`,
      )
      .bind(agencyId)
      .first<AgencyWithSource>();
    return result;
  },
);

export async function getStops(filter: StopsFilter): Promise<StopsData[]> {
  const { feed_version_id, is_parent, parent_station_pk } = filter;
  let query = `SELECT ${columnList(STOP_COLUMNS)} FROM stops`;
  const params: any[] = [];
  const conditions: string[] = [];

  if (feed_version_id) {
    conditions.push("feed_version_id = ?");
    params.push(feed_version_id);
  }

  if (is_parent) {
    conditions.push("(parent_station IS NULL)");
  }

  if (parent_station_pk !== undefined) {
    conditions.push("parent_station = ?");
    params.push(parent_station_pk);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  const result = await getDb()
    .prepare(query)
    .bind(...params)
    .all<StopsData>();
  return result.results;
}

export const getStop = cache(
  async (stopId: string, feedVersionId: number): Promise<StopsData | null> => {
    const result = await getDb()
      .prepare(
        `SELECT ${columnList(STOP_COLUMNS)} FROM stops WHERE stop_id = ? AND feed_version_id = ?`,
      )
      .bind(stopId, feedVersionId)
      .first<StopsData>();
    return result;
  },
);

export async function getRoutes(filter: RoutesFilter): Promise<RoutesData[]> {
  const { feed_version_id, agency_pk } = filter;
  let query = `SELECT ${columnList(ROUTE_COLUMNS)} FROM routes`;
  const params: any[] = [];
  const conditions: string[] = [];

  if (feed_version_id) {
    conditions.push("feed_version_id = ?");
    params.push(feed_version_id);
  }

  if (agency_pk !== undefined) {
    conditions.push("agency_pk = ?");
    params.push(agency_pk);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY route_sort_order ASC, route_short_name ASC";

  const result = await getDb()
    .prepare(query)
    .bind(...params)
    .all<RoutesData>();
  return result.results;
}

export const getRoute = cache(
  async (
    routeId: string,
    feedVersionId: number,
  ): Promise<RoutesData | null> => {
    const result = await getDb()
      .prepare(
        `SELECT ${columnList(ROUTE_COLUMNS)} FROM routes WHERE route_id = ? AND feed_version_id = ?`,
      )
      .bind(routeId, feedVersionId)
      .first<RoutesData>();
    return result;
  },
);

export const getRouteByPk = cache(
  async (routePk: number): Promise<RoutesData | null> => {
    const result = await getDb()
      .prepare(
        `SELECT ${columnList(ROUTE_COLUMNS)} FROM routes WHERE route_pk = ?`,
      )
      .bind(routePk)
      .first<RoutesData>();
    return result;
  },
);

// Route PKs are unique across imported schedules. Retain one completed
// static result per isolate without keeping any request-owned D1 promises.
let lastRouteStops:
  | { routePk: number; stops: RouteStopData[]; expiresAt: number }
  | undefined;

export async function getRouteStops(routePk: number): Promise<RouteStopData[]> {
  if (
    lastRouteStops?.routePk === routePk &&
    lastRouteStops.expiresAt > Date.now()
  ) {
    return lastRouteStops.stops;
  }
  const result = await getDb()
    .prepare(ROUTE_STOPS_SQL)
    .bind(routePk)
    .all<RouteStopData>();
  if (result.results.length) {
    // Bound staleness if a read replica was still catching up to a new import.
    lastRouteStops = {
      routePk,
      stops: result.results,
      expiresAt: Date.now() + 5 * 60_000,
    };
  }
  return result.results;
}

export const getTrip = cache(
  async (tripId: string, feedVersionId: number): Promise<TripData | null> => {
    const result = await getDb()
      .prepare(
        `SELECT ${columnList(TRIP_COLUMNS)} FROM trips WHERE trip_id = ? AND feed_version_id = ?`,
      )
      .bind(tripId, feedVersionId)
      .first<TripData>();
    return result;
  },
);

export async function getTripStops(
  tripPk: number,
  tripId: string,
  sourceName: string,
  todayNoon: number,
): Promise<TripStopData[]> {
  const { sql, params } = buildTripStopsQuery(tripPk);
  const [result, rt] = await Promise.all([
    getDb()
      .prepare(sql)
      .bind(...params)
      .all<
        Omit<TripStopData, "delay" | "departure_delay" | "realtime_status">
      >(),
    getRealtimeTripUpdates("RG"),
  ]);
  return mergeTripStopsRealtime(
    result.results,
    tripId,
    rt,
    sourceName,
    todayNoon,
  );
}

export async function getDeparturesWithRealtime(
  filter: DeparturesFilter,
  sourceName: string,
): Promise<{ departures: DeparturesData[]; realtime: RealtimeFeedStatus }> {
  if (!filter.feed_version_id) {
    return {
      departures: [],
      realtime: {
        status: "not_requested",
        sourceUpdatedAt: null,
        httpStatus: null,
      },
    };
  }

  const { sql, params } = buildDeparturesQuery(filter);
  const [result, { updates, realtime }] = await Promise.all([
    getDb()
      .prepare(sql)
      .bind(...params)
      .all<Omit<DeparturesData, "delay" | "realtime_status">>(),
    getRealtimeSnapshot("RG"),
  ]);
  return {
    departures: mergeDeparturesRealtime(
      result.results,
      updates,
      sourceName,
      filter,
    ),
    realtime,
  };
}

export async function getDepartures(
  filter: DeparturesFilter,
  sourceName: string,
): Promise<DeparturesData[]> {
  const { departures } = await getDeparturesWithRealtime(filter, sourceName);
  return departures;
}
