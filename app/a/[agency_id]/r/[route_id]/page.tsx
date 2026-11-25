import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { getServiceDay } from "../../../../../src/service-day";
import {
  getAgency,
  getRoute,
  getRouteStops,
  getDepartures,
} from "../../../../../src/db";
import DepartureTime from "../../../../../src/components/DepartureTime";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agency_id: string; route_id: string }>;
}) {
  const { agency_id, route_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) return { title: "Not Found" };
  const route = await getRoute(route_id, agency.feed_version_id);
  if (!route) return { title: "Route Not Found" };
  const title = `${route.route_short_name} ${route.route_long_name ? "- " + route.route_long_name : ""} - ${agency.agency_name}`;
  return {
    title,
    description: `Stops and schedule for ${route.route_short_name} ${route.route_long_name || ""} by ${agency.agency_name}.`,
  };
}

export default async function RoutePage({
  params,
}: {
  params: Promise<{ agency_id: string; route_id: string }>;
}) {
  const { agency_id, route_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) notFound();
  const { agency_name, feed_version_id, agency_timezone } = agency;

  const route = await getRoute(route_id, feed_version_id);
  if (!route) notFound();

  const serviceDay = getServiceDay(DateTime.now().setZone(agency_timezone));
  const { todayNoon, todayColumn, currentSeconds } = serviceDay;
  const endSeconds = currentSeconds + 4 * 60 * 60;

  const [routeStops, departures] = await Promise.all([
    getRouteStops(route.route_pk),
    getDepartures(
      {
        feed_version_id,
        route_pk: route.route_pk,
        currentSeconds,
        endSeconds,
        todayNoon,
        todayColumn,
        limit: 1000,
      },
      agency.source_name,
    ),
  ]);

  const stopsByDirection = Map.groupBy(routeStops, (stop) => stop.direction_id);
  const departuresByDirection = Map.groupBy(
    departures,
    (dep) => dep.direction_id,
  );
  const directions = [...stopsByDirection.keys()].sort().map((directionId) => {
    const stops = stopsByDirection.get(directionId)!;
    const departuresByStop = Map.groupBy(
      departuresByDirection.get(directionId) ?? [],
      (dep) => dep.stop_id,
    );
    return {
      direction_id: directionId,
      headsign:
        stops[0].trip_headsign ||
        (directionId == null
          ? "Unknown direction"
          : `Direction ${directionId}`),
      stops: stops.map((stop) => ({
        ...stop,
        departures: departuresByStop.get(stop.stop_id) ?? [],
      })),
    };
  });

  const bgColor = route.route_color ? `#${route.route_color}` : "#eee";
  const textColor = route.route_text_color
    ? `#${route.route_text_color}`
    : "#000";

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <a href={`/a/${agency_id}`} className={styles.backLink}>
          &larr; Back to {agency_name}
        </a>

        <div className={styles.routeHeader}>
          <div
            className={styles.routePill}
            style={{ backgroundColor: bgColor, color: textColor }}
          >
            {route.route_short_name}
          </div>
          <h1 className={styles.title}>
            {route.route_long_name || route.route_short_name}
          </h1>
        </div>

        {route.route_desc && (
          <p className={styles.routeDesc}>{route.route_desc}</p>
        )}

        <div className={styles.routeMeta}>
          {route.route_url && (
            <p>
              <a
                href={route.route_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Official Route Page &#8599;
              </a>
            </p>
          )}
        </div>
      </div>

      <div>
        {directions.map((direction) => (
          <section
            key={direction.direction_id ?? "unknown"}
            className={styles.directionSection}
          >
            <h2>To {direction.headsign}</h2>

            <div className={styles.stopsList}>
              {direction.stops.map((stop) => (
                <div key={stop.stop_id} className={styles.stopRow}>
                  <div className={styles.stopInfo}>
                    <a
                      href={`/a/${agency_id}/s/${stop.stop_id}`}
                      className={styles.stopLink}
                    >
                      {stop.stop_name}
                    </a>
                  </div>
                  <div className={styles.stopTimes}>
                    {stop.departures.length > 0 ? (
                      stop.departures
                        .slice(0, 3)
                        .map((dep, i) => (
                          <DepartureTime
                            key={i}
                            serviceDay={serviceDay}
                            status={dep.realtime_status}
                            departureTime={dep.departure_time}
                            delay={dep.delay}
                            timezone={stop.stop_timezone || agency_timezone}
                            agencyId={agency_id}
                            tripId={dep.trip_id}
                            stopSequence={dep.stop_sequence}
                          />
                        ))
                    ) : (
                      <span className={styles.noTimes}>No upcoming times</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        {directions.length === 0 && <p>No stops found for this route.</p>}
      </div>
    </main>
  );
}
