import { defineLiveCollection } from "astro:content";
import { z } from "astro/zod";
import type { LiveLoader } from "astro/loaders";
import { env } from "cloudflare:workers";

const agenciesSchema = z.object({
  agency_name: z.string(),
  agency_id: z.string(),
  agency_pk: z.number(),
  agency_timezone: z.string(),
  feed_version_id: z.number(),
});

const stopsSchema = z.object({
  stop_pk: z.number(),
  stop_id: z.string(),
  stop_code: z.string().nullable(),
  stop_name: z.string(),
  stop_desc: z.string().nullable(),
  stop_lat: z.number(),
  stop_lon: z.number(),
  zone_id: z.string().nullable(),
  stop_url: z.string().nullable(),
  location_type: z.number().nullable(),
  parent_station: z.number().nullable(),
  stop_timezone: z.string().nullable(),
  wheelchair_boarding: z.number().nullable(),
  level_id: z.string().nullable(),
  platform_code: z.string().nullable(),
  feed_version_id: z.number(),
});

const departuresSchema = z.object({
  stop_pk: z.number(),
  stop_id: z.string(),
  route_id: z.string(),
  trip_id: z.string(),
  route_short_name: z.string().nullable(),
  route_long_name: z.string().nullable(),
  route_color: z.string().nullable(),
  route_text_color: z.string().nullable(),
  trip_headsign: z.string().nullable(),
  departure_time: z.number(),
  delay: z.number().nullable(),
  realtime_status: z.string().nullable(),
});

const routesSchema = z.object({
  route_pk: z.number(),
  route_id: z.string(),
  agency_pk: z.number().nullable(),
  feed_version_id: z.number(),
  route_short_name: z.string().nullable(),
  route_long_name: z.string().nullable(),
  route_desc: z.string().nullable(),
  route_type: z.number(),
  route_url: z.string().nullable(),
  route_color: z.string().nullable(),
  route_text_color: z.string().nullable(),
  route_sort_order: z.number().nullable(),
});

type AgenciesData = z.infer<typeof agenciesSchema>;
type StopsData = z.infer<typeof stopsSchema>;
type DeparturesData = z.infer<typeof departuresSchema>;
type RoutesData = z.infer<typeof routesSchema>;

interface StopsFilter {
  feed_version_id: number;
  is_parent?: boolean;
  parent_station_pk?: number;
}

interface RoutesFilter {
  feed_version_id: number;
  agency_pk?: number;
  route_pk?: number;
}

interface DeparturesFilter {
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
  // Use "first-unconstrained" to allow reading from replicas
  return db.withSession("first-unconstrained");
}

export const collections = {
  agencies: defineLiveCollection({
    loader: {
      name: "agencies-loader",
      loadCollection: async () => {
        const result = await getDb()
          .prepare(
            "SELECT a.* FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id WHERE fv.is_active = 1",
          )
          .all<AgenciesData>();
        return {
          entries: result.results.map((a) => ({
            id: a.agency_id,
            data: a,
          })),
        };
      },
      loadEntry: async ({ filter }) => {
        const result = await getDb()
          .prepare(
            "SELECT a.* FROM agency a JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id WHERE a.agency_id = ? AND fv.is_active = 1",
          )
          .bind(filter.id)
          .first<AgenciesData>();
        if (!result) return { error: new Error("Agency not found") };
        return {
          id: result.agency_id,
          data: result,
        };
      },
    } as LiveLoader<AgenciesData, { id: string }>,
    schema: agenciesSchema,
  }),
  stops: defineLiveCollection({
    loader: {
      name: "stops-loader",
      loadCollection: async ({ filter }) => {
        const { feed_version_id, is_parent, parent_station_pk } = filter ?? {};
        let query = "SELECT * FROM stops";
        const params: any[] = [];
        const conditions: string[] = [];

        if (feed_version_id) {
          conditions.push("feed_version_id = ?");
          params.push(feed_version_id);
        }

        if (is_parent) {
          // Parent stops are those with location_type=1 OR parent_station is NULL
          // Adjusting logic: if explicitly asked for parents, we usually want the top-level nodes.
          // Using parent_station IS NULL is the safest way to get top-level nodes.
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
        return {
          entries: result.results.map((s) => ({
            id: `${s.feed_version_id}-${s.stop_id}`,
            data: s,
          })),
        };
      },
      loadEntry: async ({ filter }) => {
        const result = await getDb()
          .prepare(
            "SELECT * FROM stops WHERE stop_id = ? AND feed_version_id = ?",
          )
          .bind(filter.id, filter.feed_version_id)
          .first<StopsData>();
        if (!result) return { error: new Error("Stop not found") };
        return {
          id: `${result.feed_version_id}-${result.stop_id}`,
          data: result,
        };
      },
    } as LiveLoader<
      StopsData,
      { id: string; feed_version_id: number },
      StopsFilter
    >,
    schema: stopsSchema,
  }),
  routes: defineLiveCollection({
    loader: {
      name: "routes-loader",
      loadCollection: async ({ filter }) => {
        const { feed_version_id, agency_pk, route_pk } = filter ?? {};
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

        // Order by sort_order if available, then short_name
        query += " ORDER BY route_sort_order ASC, route_short_name ASC";

        const result = await getDb()
          .prepare(query)
          .bind(...params)
          .all<RoutesData>();
        return {
          entries: result.results.map((r) => ({
            id: `${r.feed_version_id}-${r.route_id}`,
            data: r,
          })),
        };
      },
      loadEntry: async ({ filter }) => {
        const result = await getDb()
          .prepare(
            "SELECT * FROM routes WHERE route_id = ? AND feed_version_id = ?",
          )
          .bind(filter.id, filter.feed_version_id)
          .first<RoutesData>();
        if (!result) return { error: new Error("Route not found") };
        return {
          id: `${result.feed_version_id}-${result.route_id}`,
          data: result,
        };
      },
    } as LiveLoader<
      RoutesData,
      { id: string; feed_version_id: number },
      RoutesFilter
    >,
    schema: routesSchema,
  }),
  route_stops: defineLiveCollection({
    loader: {
      name: "route-stops-loader",
      loadCollection: async ({ filter }) => {
        const { route_pk } = filter ?? {};
        if (route_pk === undefined) return { entries: [] };

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

        const result = await getDb().prepare(query).bind(route_pk).all<
          StopsData & {
            direction_id: number;
            stop_sequence: number;
            trip_headsign: string;
          }
        >();

        return {
          entries: result.results.map((s) => ({
            id: `${s.feed_version_id}-${s.stop_id}-${s.direction_id}`,
            data: s,
          })),
        };
      },
      loadEntry: async () => {
        return {
          error: new Error("loadEntry not implemented for route_stops"),
        };
      },
    } as LiveLoader<
      StopsData & {
        direction_id: number;
        stop_sequence: number;
        trip_headsign: string;
      },
      never,
      { route_pk: number }
    >,
    schema: stopsSchema.extend({
      direction_id: z.number(),
      stop_sequence: z.number(),
      trip_headsign: z.string().nullable(),
    }),
  }),
  trips: defineLiveCollection({
    loader: {
      name: "trips-loader",
      loadCollection: async () => {
        return {
          entries: [],
        };
      },
      loadEntry: async ({ filter }) => {
        const result = await getDb()
          .prepare(
            "SELECT * FROM trips WHERE trip_id = ? AND feed_version_id = ?",
          )
          .bind(filter.id, filter.feed_version_id)
          .first<any>();
        if (!result) return { error: new Error("Trip not found") };
        return {
          id: `${result.feed_version_id}-${result.trip_id}`,
          data: result,
        };
      },
    } as LiveLoader<any, { id: string; feed_version_id: number }, never>,
    schema: z.object({
      trip_pk: z.number(),
      feed_version_id: z.number(),
      trip_id: z.string(),
      route_pk: z.number(),
      service_id: z.string(),
      trip_headsign: z.string().nullable(),
      trip_short_name: z.string().nullable(),
      direction_id: z.number().nullable(),
      block_id: z.string().nullable(),
      shape_id: z.string().nullable(),
      wheelchair_accessible: z.number().nullable(),
      bikes_allowed: z.number().nullable(),
    }),
  }),
  trip_stops: defineLiveCollection({
    loader: {
      name: "trip-stops-loader",
      loadCollection: async ({ filter }) => {
        const { trip_pk } = filter ?? {};
        if (trip_pk === undefined) return { entries: [] };

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
                  LEFT JOIN trip_updates tu ON st.trip_pk = tu.trip_pk
                    AND tu.update_pk = (SELECT MAX(update_pk)
                                        FROM trip_updates tu2
                                        WHERE tu2.trip_pk = st.trip_pk)
                  WHERE st.trip_pk = ?
                  ORDER BY st.stop_sequence ASC
              `;

        const result = await getDb().prepare(query).bind(trip_pk).all<
          StopsData & {
            arrival_time: number | null;
            departure_time: number | null;
            stop_sequence: number;
            timepoint: number | null;
            pickup_type: number | null;
            drop_off_type: number | null;
            delay: number | null;
          }
        >();

        return {
          entries: result.results.map((s) => ({
            id: `${s.feed_version_id}-${s.stop_id}-${s.stop_sequence}`,
            data: s,
          })),
        };
      },
      loadEntry: async () => {
        return {
          error: new Error("loadEntry not implemented for trip_stops"),
        };
      },
    } as LiveLoader<
      StopsData & {
        arrival_time: number | null;
        departure_time: number | null;
        stop_sequence: number;
        timepoint: number | null;
        pickup_type: number | null;
        drop_off_type: number | null;
        delay: number | null;
      },
      never,
      { trip_pk: number }
    >,
    schema: stopsSchema.extend({
      arrival_time: z.number().nullable(),
      departure_time: z.number().nullable(),
      stop_sequence: z.number(),
      timepoint: z.number().nullable(),
      pickup_type: z.number().nullable(),
      drop_off_type: z.number().nullable(),
      delay: z.number().nullable(),
    }),
  }),
  departures: defineLiveCollection({
    loader: {
      name: "departures-loader",
      loadCollection: async ({ filter }) => {
        if (!filter) return { entries: [] };
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
          return { entries: [] };
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
        // Calendar params (used 4 times in the query below)
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
                tu.delay,
                tu.status as realtime_status
            FROM stop_times st
            JOIN stops s ON st.stop_pk = s.stop_pk
            JOIN trips t ON st.trip_pk = t.trip_pk
            JOIN routes r ON t.route_pk = r.route_pk
            LEFT JOIN trip_updates tu ON tu.trip_pk = t.trip_pk
              AND tu.update_pk = (SELECT MAX(update_pk)
                                  FROM trip_updates tu2
                                  WHERE tu2.trip_pk = t.trip_pk)
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

        return {
          entries: result.results.map((dep, index) => ({
            id: `${dep.stop_id}-${dep.route_short_name || dep.route_long_name}-${dep.departure_time}-${index}`,
            data: dep,
          })),
        };
      },
      loadEntry: async () => {
        return { error: new Error("loadEntry not implemented for departures") };
      },
    } as LiveLoader<DeparturesData, never, DeparturesFilter>,
    schema: departuresSchema,
  }),
};
