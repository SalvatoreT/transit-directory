import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { getServiceDay } from "../../../../../src/service-day";
import {
  getAgency,
  getTrip,
  getRouteByPk,
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
  const route = await getRouteByPk(trip.route_pk);
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

  const serviceDay = getServiceDay(DateTime.now().setZone(agency_timezone));
  const { currentSeconds } = serviceDay;

  const [route, stops] = await Promise.all([
    getRouteByPk(trip.route_pk),
    getTripStops(
      trip.trip_pk,
      trip.trip_id,
      agency.source_name,
      serviceDay.todayNoon,
    ),
  ]);
  const routeColor = route?.route_color ? `#${route.route_color}` : "#eee";
  const routeTextColor = route?.route_text_color
    ? `#${route.route_text_color}`
    : "#000";

  const selectedStop =
    selectedStopSequence !== null
      ? stops.find((s) => s.stop_sequence === selectedStopSequence)
      : null;

  const arrival =
    selectedStop?.arrival_time == null
      ? null
      : selectedStop.arrival_time + (selectedStop.delay ?? 0);
  const departure =
    selectedStop?.departure_time == null
      ? null
      : selectedStop.departure_time + (selectedStop.departure_delay ?? 0);
  const countdownSeconds = arrival ?? departure;

  return (
    <main className={styles.main}>
      {selectedStop && (
        <StopHero
          routeColor={routeColor}
          routeTextColor={routeTextColor}
          stopName={selectedStop.stop_name}
          arrivalFormatted={
            arrival == null
              ? null
              : serviceDay.formatTime(arrival, agency_timezone)
          }
          departureFormatted={
            departure == null
              ? null
              : serviceDay.formatTime(departure, agency_timezone)
          }
          countdownTimestamp={
            countdownSeconds == null
              ? null
              : serviceDay.start.toMillis() + countdownSeconds * 1000
          }
          status={selectedStop.realtime_status}
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
            const time = stop.departure_time ?? stop.arrival_time;
            const delay =
              (stop.departure_time == null
                ? stop.delay
                : stop.departure_delay) ?? 0;
            const isPast = time != null && time + delay < currentSeconds;

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
                    serviceDay={serviceDay}
                    status={stop.realtime_status}
                    departureTime={stop.arrival_time ?? stop.departure_time}
                    delay={
                      stop.arrival_time == null
                        ? stop.departure_delay
                        : stop.delay
                    }
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
