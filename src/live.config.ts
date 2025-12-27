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
  stop_name: z.string(),
  stop_lat: z.number(),
  stop_lon: z.number(),
  stop_timezone: z.string().nullable(),
  feed_version_id: z.number(),
});

const departuresSchema = z.object({
  stop_pk: z.number(),
  stop_id: z.string(),
  route_short_name: z.string().nullable(),
  route_long_name: z.string().nullable(),
  route_color: z.string().nullable(),
  route_text_color: z.string().nullable(),
  trip_headsign: z.string().nullable(),
  departure_time: z.number(),
  delay: z.number().nullable(),
  realtime_status: z.string().nullable(),
});

type AgenciesData = z.infer<typeof agenciesSchema>;
type StopsData = z.infer<typeof stopsSchema>;
type DeparturesData = z.infer<typeof departuresSchema>;

interface StopsFilter {
  feed_version_id: number;
}

interface DeparturesFilter {
  feed_version_id: number;
  stopPks: number[];
  currentSeconds: number;
  twoHoursLaterSeconds: number;
  todayNoon: number;
  todayColumn: string;
}

function getDb(): D1Database {
  return (env as any).gtfs_data as D1Database;
}

export const collections = {
  agencies: defineLiveCollection({
    loader: {
      name: "agencies-loader",
      loadCollection: async () => {
        const result = await getDb()
          .prepare("SELECT * FROM agency")
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
          .prepare("SELECT * FROM agency WHERE agency_id = ?")
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
        const { feed_version_id } = filter ?? {};
        let query = "SELECT * FROM stops";
        const params: any[] = [];
        if (feed_version_id) {
          query += " WHERE feed_version_id = ?";
          params.push(feed_version_id);
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
  departures: defineLiveCollection({
    loader: {
      name: "departures-loader",
      loadCollection: async ({ filter }) => {
        if (!filter) return { entries: [] };
        const {
          feed_version_id,
          stopPks,
          currentSeconds,
          twoHoursLaterSeconds,
          todayNoon,
          todayColumn,
        } = filter;

        if (!feed_version_id || !stopPks || stopPks.length === 0) {
          return { entries: [] };
        }

        const placeholders = stopPks.map(() => "?").join(",");
        const query = `
            SELECT
                s.stop_pk,
                s.stop_id,
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
LEFT JOIN (
                SELECT *, MAX(update_pk) FROM trip_updates GROUP BY trip_pk
            ) tu ON tu.trip_pk = t.trip_pk
            WHERE s.feed_version_id = ?
              AND s.stop_pk IN (${placeholders})
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
          .bind(
            feed_version_id,
            ...stopPks,
            currentSeconds,
            twoHoursLaterSeconds,
            todayNoon,
            todayNoon,
            todayNoon,
            todayNoon,
          )
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
