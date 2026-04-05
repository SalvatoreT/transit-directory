import { DateTime } from "luxon";
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

function formatDeparture(
  dep: DeparturesData,
  timezone: string,
): TrmnlDeparture {
  const midnight = DateTime.now().setZone(timezone).startOf("day");
  const depTime = midnight.plus({ seconds: dep.departure_time });
  const timeStr = depTime.toFormat("HH:mm");

  let delayText = "Sched.";
  if (dep.delay != null) {
    const delayMin = Math.round(dep.delay / 60);
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
    time: timeStr,
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

  const departures = await getDepartures({
    feed_version_id,
    stopPks,
    currentSeconds,
    twoHoursLaterSeconds,
    todayNoon,
    todayColumn,
  });

  return {
    stopName: displayName || parentStop.stop_name,
    stopId,
    agencyName: agency_name,
    departures: departures.map((d) => formatDeparture(d, agency_timezone)),
    departureCount: departures.length,
    lastUpdated: new Date().toISOString(),
  };
}
