import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import {
  getAgency,
  getStop,
  getStops,
  getDepartures,
} from "../../../../../src/db";
import DepartureTime from "../../../../../src/components/DepartureTime";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agency_id: string; stop_id: string }>;
}) {
  const { agency_id, stop_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) return { title: "Not Found" };
  const stop = await getStop(stop_id, agency.feed_version_id);
  if (!stop) return { title: "Stop Not Found" };
  return {
    title: `${stop.stop_name} (${stop_id}) - ${agency.agency_name}`,
    description: `Upcoming departures for ${stop.stop_name} by ${agency.agency_name}.`,
  };
}

export default async function StopPage({
  params,
}: {
  params: Promise<{ agency_id: string; stop_id: string }>;
}) {
  const { agency_id, stop_id } = await params;
  const agency = await getAgency(agency_id);
  if (!agency) notFound();
  const { agency_name, feed_version_id, agency_timezone } = agency;

  const parentStop = await getStop(stop_id, feed_version_id);
  if (!parentStop) notFound();

  const childrenStops = await getStops({
    feed_version_id,
    parent_station_pk: parentStop.stop_pk,
  });

  let targetStops = childrenStops.length > 0 ? childrenStops : [parentStop];
  targetStops.sort((a, b) => a.stop_name.localeCompare(b.stop_name));

  const stopPks = targetStops.map((s) => s.stop_pk);

  const now = DateTime.now().setZone(agency_timezone);
  const midnight = now.startOf("day");
  const currentSeconds = Math.floor(now.diff(midnight, "seconds").seconds);
  const twoHoursLaterSeconds = currentSeconds + 2 * 60 * 60;
  const todayNoon = midnight.set({ hour: 12 }).toSeconds()!;
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const todayColumn = days[now.weekday % 7];

  let departures: any[] = [];
  if (stopPks.length > 0) {
    departures = await getDepartures({
      feed_version_id,
      stopPks,
      currentSeconds,
      twoHoursLaterSeconds,
      todayNoon,
      todayColumn,
    });
  }

  const stopsWithDepartures = targetStops.map((stop) => ({
    ...stop,
    departures: departures.filter((d: any) => d.stop_pk === stop.stop_pk),
  }));

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <a href={`/a/${agency_id}`} className={styles.backLink}>
          &larr; Back to {agency_name}
        </a>
        <h1 className={styles.title}>{parentStop.stop_name}</h1>
        <p className={styles.subtitle}>Stop ID: {stop_id}</p>
      </div>

      <div className={styles.stopsGrid}>
        {stopsWithDepartures.map((stop) => (
          <div key={stop.stop_pk} className={styles.stopCard}>
            <h2>
              {stop.stop_name}{" "}
              <span className={styles.stopSubId}>({stop.stop_id})</span>
            </h2>
            <div className={styles.departuresList}>
              {stop.departures.length > 0 ? (
                stop.departures.map((dep: any, i: number) => {
                  const routeColor = dep.route_color
                    ? `#${dep.route_color}`
                    : "#eee";
                  const routeTextColor = dep.route_text_color
                    ? `#${dep.route_text_color}`
                    : "#000";

                  return (
                    <div key={i} className={styles.departureRow}>
                      <a
                        href={`/a/${agency_id}/r/${dep.route_id}`}
                        className={styles.routeBadgeLink}
                        title="View Route"
                      >
                        <span
                          className={styles.routeBadge}
                          style={{
                            backgroundColor: routeColor,
                            color: routeTextColor,
                          }}
                        >
                          {dep.route_short_name || dep.route_long_name}
                        </span>
                      </a>
                      <a
                        href={`/a/${agency_id}/t/${dep.trip_id}`}
                        className={styles.headsignLink}
                      >
                        {dep.trip_headsign}
                      </a>
                      <DepartureTime
                        departureTime={dep.departure_time}
                        delay={dep.delay}
                        timezone={stop.stop_timezone || agency_timezone}
                        agencyId={agency_id}
                        tripId={dep.trip_id}
                        stopSequence={dep.stop_sequence}
                      />
                    </div>
                  );
                })
              ) : (
                <div className={styles.noDepartures}>
                  No upcoming departures in the next 2 hours.
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
