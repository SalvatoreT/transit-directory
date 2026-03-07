import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import {
  getAgency,
  getTrip,
  getRoutes,
  getTripStops,
} from "../../../../../src/db";
import DepartureTime from "../../../../../src/components/DepartureTime";
import StopHero from "../../../../../src/components/StopHero";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agency_id: string; trip_id: string }>;
}) {
  const { agency_id, trip_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) return { title: "Not Found" };
  const trip = await getTrip(trip_id, agency.feed_version_id);
  if (!trip) return { title: "Trip Not Found" };
  const routes = await getRoutes({
    feed_version_id: agency.feed_version_id,
    route_pk: trip.route_pk,
  });
  const route = routes[0];
  const tripName = trip.trip_headsign || trip.trip_short_name || trip.trip_id;
  const routeName = route?.route_short_name || "";
  return {
    title: `Trip ${tripName} - ${routeName} - ${agency.agency_name}`,
    description: `Trip details for ${tripName} on route ${routeName} by ${agency.agency_name}.`,
  };
}

export default async function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ agency_id: string; trip_id: string }>;
  searchParams: Promise<{ stop?: string }>;
}) {
  const { agency_id, trip_id } = await params;
  const { stop: stopParam } = await searchParams;
  const selectedStopSequence = stopParam ? parseInt(stopParam, 10) : null;

  const agency = await getAgency(agency_id);
  if (!agency) notFound();
  const { agency_name, feed_version_id, agency_timezone } = agency;

  const trip = await getTrip(trip_id, feed_version_id);
  if (!trip) notFound();

  const routes = await getRoutes({
    feed_version_id,
    route_pk: trip.route_pk,
  });
  const route = routes[0];
  const routeColor = route?.route_color ? `#${route.route_color}` : "#eee";
  const routeTextColor = route?.route_text_color
    ? `#${route.route_text_color}`
    : "#000";

  const stops = await getTripStops(trip.trip_pk);

  const now = DateTime.now().setZone(agency_timezone);
  const midnight = now.startOf("day");
  const currentSeconds = Math.floor(now.diff(midnight, "seconds").seconds);

  const selectedStop =
    selectedStopSequence !== null
      ? stops.find((s) => s.stop_sequence === selectedStopSequence)
      : null;

  return (
    <main className={styles.main}>
      {selectedStop && (
        <StopHero
          routeColor={routeColor}
          routeTextColor={routeTextColor}
          stopName={selectedStop.stop_name}
          arrivalSeconds={selectedStop.arrival_time}
          departureSeconds={selectedStop.departure_time}
          delay={selectedStop.delay || 0}
          timezone={agency_timezone}
        />
      )}

      <div className={styles.header}>
        <div className={styles.navLinks}>
          <a href={`/a/${agency_id}`} className={styles.backLink}>
            &larr; {agency_name}
          </a>
          {route && (
            <span className={styles.sep}>
              /
              <a
                href={`/a/${agency_id}/r/${route.route_id}`}
                className={styles.backLink}
              >
                {" "}
                Route {route.route_short_name}
              </a>
            </span>
          )}
        </div>

        <div className={styles.tripHeader}>
          <div
            className={styles.routePill}
            style={{ backgroundColor: routeColor, color: routeTextColor }}
          >
            {route?.route_short_name}
          </div>
          <h1 className={styles.title}>
            {trip.trip_headsign || trip.trip_short_name || trip.trip_id}
          </h1>
        </div>

        <p className={styles.subtitle}>
          {route?.route_long_name} &bull; Trip ID: {trip.trip_id}
        </p>
      </div>

      <div>
        <div className={styles.stopsList}>
          {stops.map((stop) => {
            const time = stop.departure_time || stop.arrival_time || 0;
            const delay = stop.delay || 0;
            const isPast = time + delay < currentSeconds;

            return (
              <div
                key={stop.stop_sequence}
                className={`${styles.stopRow} ${isPast ? styles.pastStop : ""} ${stop.stop_sequence === selectedStopSequence ? styles.selectedStop : ""}`}
              >
                <div className={styles.stopInfo}>
                  <a
                    href={`/a/${agency_id}/s/${stop.stop_id}`}
                    className={styles.stopLink}
                  >
                    {stop.stop_name}
                  </a>
                </div>
                <div className={styles.stopTimes}>
                  <DepartureTime
                    departureTime={stop.arrival_time || 0}
                    delay={stop.delay}
                    timezone={agency_timezone}
                    agencyId={agency_id}
                    tripId={trip_id}
                    stopSequence={stop.stop_sequence}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
