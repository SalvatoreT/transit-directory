import { DateTime } from "luxon";
import { getServiceDay } from "../../service-day";
import {
  getAgency,
  getStop,
  getStops,
  getDepartures,
  type DeparturesData,
} from "../../db";

export interface TrmnlUserConfig {
  agency_id: string;
  stop_id: string;
  display_name: string;
  access_token: string;
  plugin_setting_id?: string;
}

export interface TrmnlDeparture {
  routeName: string;
  headsign: string;
  time: string;
  delayText: string;
}

export interface TrmnlStopData {
  stopName: string;
  stopId: string;
  agencyName: string;
  departures: TrmnlDeparture[];
  departureCount: number;
  lastUpdated: string;
}

// Largest departure list any TRMNL layout can render (TRMNL X full layout
// caps out below this).
const MAX_TRMNL_DEPARTURES = 30;

function formatDeparture(
  dep: DeparturesData,
  serviceStart: DateTime,
): TrmnlDeparture {
  let delayText = "Sched.";
  const canceled = dep.realtime_status === "CANCELED";
  const skipped = dep.realtime_status === "SKIPPED";
  const delay = canceled || skipped ? null : dep.delay;
  if (canceled) {
    delayText = "Canceled";
  } else if (skipped) {
    delayText = "Skipped";
  } else if (delay != null) {
    const delayMin = Math.round(delay / 60);
    if (delayMin > 0) {
      delayText = `+${delayMin} min late`;
    } else if (delayMin < 0) {
      delayText = `${delayMin} min early`;
    } else {
      delayText = "On Time";
    }
  }

  return {
    routeName: dep.route_short_name || dep.route_long_name || dep.route_id,
    headsign: dep.trip_headsign || "Unknown",
    time: serviceStart
      .plus({ seconds: dep.departure_time + (delay ?? 0) })
      .toFormat("HH:mm"),
    delayText,
  };
}

export async function getTrmnlData(
  agencyId: string,
  stopId: string,
  displayName?: string,
): Promise<TrmnlStopData> {
  const agency = await getAgency(agencyId);
  if (!agency) {
    return {
      stopName: displayName || stopId,
      stopId,
      agencyName: agencyId,
      departures: [],
      departureCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  const { agency_name, feed_version_id, agency_timezone } = agency;

  const parentStop = await getStop(stopId, feed_version_id);
  if (!parentStop) {
    return {
      stopName: displayName || stopId,
      stopId,
      agencyName: agency_name,
      departures: [],
      departureCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  const childrenStops = await getStops({
    feed_version_id,
    parent_station_pk: parentStop.stop_pk,
  });

  const targetStops = childrenStops.length > 0 ? childrenStops : [parentStop];
  const stopPks = targetStops.map((s) => s.stop_pk);

  const { start, todayNoon, todayColumn, currentSeconds } = getServiceDay(
    DateTime.now().setZone(agency_timezone),
  );
  const endOfDaySeconds = 24 * 60 * 60;

  const departures = await getDepartures(
    {
      feed_version_id,
      stopPks,
      currentSeconds,
      endSeconds: endOfDaySeconds,
      todayNoon,
      todayColumn,
    },
    agency.source_name,
  );

  return {
    stopName: displayName || parentStop.stop_name,
    stopId,
    agencyName: agency_name,
    // departureCount keeps the full rest-of-day total (the display shows it),
    // but no layout renders more than ~27 rows, so cap the payload.
    departures: departures
      .slice(0, MAX_TRMNL_DEPARTURES)
      .map((d) => formatDeparture(d, start)),
    departureCount: departures.length,
    lastUpdated: new Date().toISOString(),
  };
}
