import { env } from "cloudflare:workers";

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
  route_short_name: string | null;
  route_long_name: string | null;
  route_color: string | null;
  route_text_color: string | null;
  trip_headsign: string | null;
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
  direction_id: number;
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
}

export interface StopsFilter {
  feed_version_id: number;
  is_parent?: boolean;
  parent_station_pk?: number;
}

export interface RoutesFilter {
  feed_version_id: number;
  agency_pk?: number;
  route_pk?: number;
}

export interface DeparturesFilter {
  feed_version_id: number;
  stopPks?: number[];
  route_pk?: number;
  currentSeconds: number;
  twoHoursLaterSeconds: number;
  todayNoon: number;
  todayColumn: string;
}

function getDb() {
  const db = (env as any).gtfs_data as D1Database;
  return db.withSession("first-unconstrained");
}

export async function getAgencies(): Promise<AgenciesData[]> {
  const result = await getDb()
    .prepare(
      "SELECT a.* FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id WHERE fv.is_active = 1",
    )
    .all<AgenciesData>();
  return result.results;
}

export async function getAgency(
  agencyId: string,
): Promise<AgenciesData | null> {
  const result = await getDb()
    .prepare(
      "SELECT a.* FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id WHERE a.agency_id = ? AND fv.is_active = 1",
    )
    .bind(agencyId)
    .first<AgenciesData>();
  return result;
}

export async function getStops(filter: StopsFilter): Promise<StopsData[]> {
  const { feed_version_id, is_parent, parent_station_pk } = filter;
  let query = "SELECT * FROM stops";
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

export async function getStop(
  stopId: string,
  feedVersionId: number,
): Promise<StopsData | null> {
  const result = await getDb()
    .prepare("SELECT * FROM stops WHERE stop_id = ? AND feed_version_id = ?")
    .bind(stopId, feedVersionId)
    .first<StopsData>();
  return result;
}

export async function getRoutes(filter: RoutesFilter): Promise<RoutesData[]> {
  const { feed_version_id, agency_pk, route_pk } = filter;
  let query = "SELECT * FROM routes";
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

  if (route_pk !== undefined) {
    conditions.push("route_pk = ?");
    params.push(route_pk);
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

export async function getRoute(
  routeId: string,
  feedVersionId: number,
): Promise<RoutesData | null> {
  const result = await getDb()
    .prepare("SELECT * FROM routes WHERE route_id = ? AND feed_version_id = ?")
    .bind(routeId, feedVersionId)
    .first<RoutesData>();
  return result;
}

export async function getRouteStops(routePk: number): Promise<RouteStopData[]> {
  const query = `
    WITH TripStops AS (
        SELECT
            t.trip_pk,
            t.direction_id,
            t.trip_headsign,
            COUNT(st.stop_time_pk) as stop_count
        FROM trips t
        JOIN stop_times st ON t.trip_pk = st.trip_pk
        WHERE t.route_pk = ?
        GROUP BY t.trip_pk, t.direction_id, t.trip_headsign
    ),
    BestTrips AS (
        SELECT direction_id, trip_pk, trip_headsign
        FROM (
            SELECT direction_id, trip_pk, trip_headsign,
                   ROW_NUMBER() OVER (PARTITION BY direction_id ORDER BY stop_count DESC) as rn
            FROM TripStops
        ) WHERE rn = 1
    )
    SELECT
        s.*,
        bt.direction_id,
        bt.trip_headsign,
        st.stop_sequence
    FROM stops s
    JOIN stop_times st ON s.stop_pk = st.stop_pk
    JOIN BestTrips bt ON st.trip_pk = bt.trip_pk
    ORDER BY bt.direction_id, st.stop_sequence
  `;

  const result = await getDb()
    .prepare(query)
    .bind(routePk)
    .all<RouteStopData>();
  return result.results;
}

export async function getTrip(
  tripId: string,
  feedVersionId: number,
): Promise<TripData | null> {
  const result = await getDb()
    .prepare("SELECT * FROM trips WHERE trip_id = ? AND feed_version_id = ?")
    .bind(tripId, feedVersionId)
    .first<TripData>();
  return result;
}

export async function getTripStops(tripPk: number): Promise<TripStopData[]> {
  const query = `
    SELECT
        s.*,
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
    WHERE st.trip_pk = ?
    ORDER BY st.stop_sequence ASC
  `;

  const result = await getDb().prepare(query).bind(tripPk).all<TripStopData>();
  return result.results;
}

export async function getDepartures(
  filter: DeparturesFilter,
): Promise<DeparturesData[]> {
  const {
    feed_version_id,
    stopPks,
    route_pk,
    currentSeconds,
    twoHoursLaterSeconds,
    todayNoon,
    todayColumn,
  } = filter;

  if (!feed_version_id) {
    return [];
  }

  const conditions: string[] = ["s.feed_version_id = ?"];
  const params: any[] = [feed_version_id];

  if (stopPks && stopPks.length > 0) {
    const placeholders = stopPks.map(() => "?").join(",");
    conditions.push(`s.stop_pk IN (${placeholders})`);
    params.push(...stopPks);
  }

  if (route_pk !== undefined) {
    conditions.push("r.route_pk = ?");
    params.push(route_pk);
  }

  params.push(currentSeconds, twoHoursLaterSeconds);
  const calendarParams = [todayNoon, todayNoon, todayNoon, todayNoon];

  const query = `
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

  const result = await getDb()
    .prepare(query)
    .bind(...params, ...calendarParams)
    .all<DeparturesData>();
  return result.results;
}
