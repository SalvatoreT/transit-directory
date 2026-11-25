import { DateTime } from "luxon";
import { getServiceDay } from "../../service-day";
import type { RealtimeFeedStatus } from "../../realtime-feed";
import {
  getAgency,
  getStop,
  getStops,
  getDeparturesWithRealtime,
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

type TrmnlBoard = TrmnlStopData & {
  realtime: RealtimeFeedStatus & { updatedDepartures: number };
};

const noFeedRequested: TrmnlBoard["realtime"] = {
  status: "not_requested",
  sourceUpdatedAt: null,
  httpStatus: null,
  updatedDepartures: 0,
};

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
): Promise<TrmnlBoard> {
  const agency = await getAgency(agencyId);
  if (!agency) {
    return {
      stopName: displayName || stopId,
      stopId,
      agencyName: agencyId,
      departures: [],
      departureCount: 0,
      realtime: noFeedRequested,
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
      realtime: noFeedRequested,
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

  const { departures, realtime } = await getDeparturesWithRealtime(
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

  // The display shows the rest-of-day total; only the first rows need formatting.
  let updatedDepartures = 0;
  const visible = departures.slice(0, MAX_TRMNL_DEPARTURES).map((row) => {
    const departure = formatDeparture(row, start);
    if (departure.delayText !== "Sched.") updatedDepartures++;
    return departure;
  });
  return {
    stopName: displayName || parentStop.stop_name,
    stopId,
    agencyName: agency_name,
    departures: visible,
    departureCount: departures.length,
    realtime: { ...realtime, updatedDepartures },
    lastUpdated: new Date().toISOString(),
  };
}
