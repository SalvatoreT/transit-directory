import { transit_realtime } from "./gtfs-realtime";

export interface FeedResponse {
  // null when the request was rate limited (HTTP 429).
  message: transit_realtime.IFeedMessage | null;
  rateLimited: boolean;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
}

export async function fetchAndDecodeFeed(url: string): Promise<FeedResponse> {
  const response = await fetch(url);

  const rateLimitLimitHeader = response.headers.get("RateLimit-Limit");
  const rateLimitRemainingHeader = response.headers.get("RateLimit-Remaining");
  const rateLimitLimit = rateLimitLimitHeader
    ? parseInt(rateLimitLimitHeader, 10)
    : null;
  const rateLimitRemaining = rateLimitRemainingHeader
    ? parseInt(rateLimitRemainingHeader, 10)
    : null;

  if (response.status === 429) {
    return {
      message: null,
      rateLimited: true,
      rateLimitLimit,
      rateLimitRemaining: rateLimitRemaining ?? 0,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch feed from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  try {
    return {
      message: transit_realtime.FeedMessage.decode(buffer),
      rateLimited: false,
      rateLimitLimit,
      rateLimitRemaining,
    };
  } catch (err) {
    console.error(`Error decoding GTFS-Realtime feed from ${url}:`, err);
    throw err;
  }
}

// Regional feeds prefix trip/route/stop IDs with "{agency}:" (e.g. "BA:1841778").
// Static GTFS stores them without the prefix, so we strip it before DB lookups.
export function stripAgencyPrefix(id: string): string {
  const idx = id.indexOf(":");
  return idx >= 0 ? id.substring(idx + 1) : id;
}

export type TripUpdateStatus =
  | "SCHEDULED"
  | "ADDED"
  | "UNSCHEDULED"
  | "CANCELED";

export interface TripUpdateState {
  // Prefix-stripped trip id, matching static GTFS.
  tripId: string;
  delay: number;
  status: TripUpdateStatus;
}

// Reduces a GTFS-Realtime feed entity to the per-trip state we persist:
// trip-level delay (falling back to the first stop time update), and
// schedule relationship mapped to a status string.
export function extractTripUpdateState(
  entity: transit_realtime.IFeedEntity,
): TripUpdateState | null {
  if (!entity.tripUpdate || !entity.tripUpdate.trip) return null;
  const rawTripId = entity.tripUpdate.trip.tripId;
  if (!rawTripId) return null;

  const tripId = stripAgencyPrefix(rawTripId);

  let effectiveDelay = entity.tripUpdate.delay || 0;
  if (!effectiveDelay && entity.tripUpdate.stopTimeUpdate?.length) {
    const firstUpdate = entity.tripUpdate.stopTimeUpdate[0];
    effectiveDelay =
      firstUpdate.arrival?.delay || firstUpdate.departure?.delay || 0;
  }

  let status: TripUpdateStatus = "SCHEDULED";
  if (entity.tripUpdate.trip.scheduleRelationship) {
    const rel = entity.tripUpdate.trip.scheduleRelationship;
    if (rel === 1) status = "ADDED";
    if (rel === 2) status = "UNSCHEDULED";
    if (rel === 3) status = "CANCELED";
  }

  return { tripId, delay: effectiveDelay, status };
}
