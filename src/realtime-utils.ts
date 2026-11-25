import type { transit_realtime } from "./gtfs-realtime";

type StopUpdate = transit_realtime.TripUpdate.IStopTimeUpdate;
type StopEvent = transit_realtime.TripUpdate.IStopTimeEvent;

export const MAX_TRIP_AGE_MS = 90_000;

export interface RealtimeEntry {
  validUntil: number;
  delay: number | null;
  status: "SCHEDULED" | "UNSCHEDULED" | "CANCELED" | "DELETED";
  stops: StopUpdate[];
}

// Protobufjs exposes absent optional scalars as prototype defaults. In GTFS-RT
// a missing delay means unknown, while an explicit zero means on time.
function reportedDelay(
  event?: { delay?: number | null } | null,
): number | null {
  return event && Object.hasOwn(event, "delay") ? (event.delay ?? null) : null;
}

// Relationships for extra, duplicated or replacement trips do not overlay
// the original static trip's times.
const staticTripStatuses: Readonly<
  Partial<Record<number, RealtimeEntry["status"]>>
> = {
  0: "SCHEDULED",
  2: "UNSCHEDULED",
  3: "CANCELED",
  7: "DELETED",
};

export function buildRealtimeMap(
  entities: transit_realtime.IFeedEntity[],
): Map<string, RealtimeEntry> {
  const entries = new Map<string, RealtimeEntry>();
  const now = Date.now();
  for (const entity of entities) {
    const update = entity.tripUpdate;
    const trip = update?.trip;
    if (!update || !trip?.tripId || entity.isDeleted) continue;
    const status = staticTripStatuses[trip.scheduleRelationship ?? 0];
    if (!status) continue;
    // Some operators stop reporting while the regional feed continues to
    // publish. An absent trip timestamp inherits the feed's own lifetime.
    const validUntil =
      Object.hasOwn(update, "timestamp") && update.timestamp != null
        ? Number(update.timestamp) * 1000 + MAX_TRIP_AGE_MS
        : Infinity;
    if (validUntil <= now) continue;
    const key = trip.startDate
      ? `${trip.startDate}\0${trip.tripId}`
      : trip.tripId;
    entries.set(key, {
      validUntil,
      delay: reportedDelay(update),
      status,
      stops: update.stopTimeUpdate ?? [],
    });
  }
  return entries;
}

type ScheduledStop = {
  stop_id: string;
  stop_sequence: number;
  arrival_time: number | null;
  departure_time: number | null;
};

interface Prediction {
  delay: number | null;
  departure_delay: number | null;
  realtime_status: string | null;
}

function findTrip(
  entries: Map<string, RealtimeEntry>,
  sourceName: string,
  tripId: string,
  serviceDate: string,
  now: number,
) {
  // Imported operator feeds have local ids. A regional static feed already
  // has the same qualified ids as the shared regional realtime feed.
  const key = sourceName === "RG" ? tripId : `${sourceName}:${tripId}`;
  const entry = entries.get(`${serviceDate}\0${key}`) ?? entries.get(key);
  return entry && entry.validUntil > now ? entry : undefined;
}

function serviceDateKey(todayNoon: number): string {
  // All 511 feeds use Pacific time. Local noon falls on the same UTC date.
  return new Date(todayNoon * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
}

function eventDelay(
  event: StopEvent | null | undefined,
  scheduled: number | null | undefined,
  start: number,
): number | null {
  if (
    event &&
    Object.hasOwn(event, "time") &&
    event.time != null &&
    scheduled != null
  ) {
    return Number(event.time) - (start + scheduled);
  }
  return reportedDelay(event);
}

function scheduledPrediction<T extends ScheduledStop>(row: T): T & Prediction {
  return { ...row, delay: null, departure_delay: null, realtime_status: null };
}

// Only index stop updates for trips on the requested page. Work on each
// matched trip once, even when the board contains many of its stops.
function applyTripUpdate<T extends ScheduledStop>(
  rows: (T & Prediction)[],
  entry: RealtimeEntry,
  sourceName: string,
  start: number,
) {
  for (const row of rows) row.realtime_status = entry.status;
  if (entry.status === "CANCELED" || entry.status === "DELETED") return;
  if (entry.stops.length === 0) {
    for (const row of rows) row.delay = row.departure_delay = entry.delay;
    return;
  }

  const bySequence = new Map(rows.map((row) => [row.stop_sequence, row]));
  const byId = new Map(rows.map((row) => [row.stop_id, row]));
  const changes: [number, number | null][] = [];
  const exact = new Set<number>();
  let allStopsLocated = true;
  const prefix = `${sourceName}:`;
  for (const update of entry.stops) {
    const id = update.stopId ?? "";
    const localId =
      sourceName !== "RG" && id.startsWith(prefix)
        ? id.slice(prefix.length)
        : id;
    const seq = Object.hasOwn(update, "stopSequence")
      ? update.stopSequence
      : byId.get(localId)?.stop_sequence;
    if (seq == null) {
      // With a partial board we may lack the sequence for an id-only update.
      // Its position is unknown, so infer no delays for other stops.
      allStopsLocated = false;
      continue;
    }
    const row = bySequence.get(seq);
    if (row) exact.add(seq);
    if (update.scheduleRelationship === 1) {
      if (row) row.realtime_status = "SKIPPED";
      continue; // A skipped stop does not interrupt propagation.
    }
    if (update.scheduleRelationship === 2) {
      changes.push([seq, null]); // NO_DATA also resets predictions downstream.
      continue;
    }
    const arrival = eventDelay(update.arrival, row?.arrival_time, start);
    const departure = eventDelay(update.departure, row?.departure_time, start);
    if (row) {
      row.delay = arrival ?? departure;
      row.departure_delay = departure ?? arrival;
    }
    changes.push([seq, departure ?? arrival]);
  }
  if (!allStopsLocated) return;

  // Producers should order updates by sequence. Normalize here so an
  // out-of-order update cannot propagate its delay past the next boundary.
  changes.sort(([a], [b]) => a - b);
  const cursor = changes.values();
  let next = cursor.next();
  let delay = entry.delay;
  for (const row of rows.toSorted(
    (a, b) => a.stop_sequence - b.stop_sequence,
  )) {
    while (!next.done && next.value[0] <= row.stop_sequence) {
      delay = next.value[1];
      next = cursor.next();
    }
    if (!exact.has(row.stop_sequence)) row.delay = row.departure_delay = delay;
  }
}

export function mergeTripStopsRealtime<T extends ScheduledStop>(
  rows: T[],
  tripId: string,
  entries: Map<string, RealtimeEntry>,
  sourceName: string,
  todayNoon: number,
): (T & Prediction)[] {
  const stops = rows.map(scheduledPrediction);
  const entry = findTrip(
    entries,
    sourceName,
    tripId,
    serviceDateKey(todayNoon),
    Date.now(),
  );
  if (entry?.status === "DELETED") return [];
  if (entry) applyTripUpdate(stops, entry, sourceName, todayNoon - 43200);
  return stops;
}

export function mergeDeparturesRealtime<
  T extends ScheduledStop & { trip_id: string; departure_time: number },
>(
  rows: T[],
  entries: Map<string, RealtimeEntry>,
  sourceName: string,
  window: { todayNoon: number; currentSeconds: number; endSeconds: number },
): (T & Prediction)[] {
  const departures = rows.map(scheduledPrediction);
  if (!entries.size || !rows.length) return departures;
  const date = serviceDateKey(window.todayNoon);
  const now = Date.now();
  const byTrip = Map.groupBy(departures, (row) => row.trip_id);
  let anyUpdates = false;
  for (const [tripId, tripRows] of byTrip) {
    const entry = findTrip(entries, sourceName, tripId, date, now);
    if (!entry) continue;
    anyUpdates = true;
    applyTripUpdate(tripRows, entry, sourceName, window.todayNoon - 43200);
    for (const row of tripRows) row.delay = row.departure_delay;
  }
  if (!anyUpdates) return departures;
  const expected = (row: T & Prediction) =>
    row.departure_time + (row.delay ?? 0);
  return departures
    .filter(
      (row) =>
        row.realtime_status !== "DELETED" &&
        expected(row) >= window.currentSeconds &&
        expected(row) <= window.endSeconds,
    )
    .sort((a, b) => expected(a) - expected(b));
}
