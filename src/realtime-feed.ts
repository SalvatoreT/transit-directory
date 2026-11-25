import { env } from "cloudflare:workers";
import { cache } from "react";
import { transit_realtime } from "./gtfs-realtime";
import {
  buildRealtimeMap,
  MAX_TRIP_AGE_MS,
  type RealtimeEntry,
} from "./realtime-utils";

const RT_CACHE_TTL_SECONDS = 15;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 60;
const REFRESH_AT_HEADER = "X-Transit-Refresh-At";
const RETRY_HEADER = "X-Transit-Retry";

interface Snapshot {
  agencyId: string;
  refreshAt: number;
  validUntil: number;
  retrying: boolean;
  updates: Map<string, RealtimeEntry>;
}

// Keep only plain, completed data across requests. Streams and in-flight fetch
// promises belong to the Cloudflare request that initiated them.
let latest: Snapshot | undefined;

function freshSnapshot(
  agencyId: string,
  acceptRetry = true,
): Snapshot | undefined {
  const now = Date.now();
  if (latest && latest.refreshAt <= now && latest.validUntil <= now)
    latest = undefined;
  if (
    latest?.agencyId === agencyId &&
    latest.refreshAt > now &&
    (acceptRetry || !latest.retrying)
  )
    return latest;
}

function rememberSnapshot(
  agencyId: string,
  buffer: ArrayBuffer | null,
  refreshAt: number,
  retrying = false,
): Snapshot {
  if (
    retrying &&
    latest?.agencyId === agencyId &&
    latest.validUntil > Date.now()
  ) {
    latest = { ...latest, refreshAt, retrying };
    return latest;
  }
  let validUntil = refreshAt;
  let updates = new Map<string, RealtimeEntry>();
  if (buffer?.byteLength) {
    const message = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    if (Object.hasOwn(message.header, "timestamp")) {
      const publishedAt = Number(message.header.timestamp) * 1000;
      // A missing or future source timestamp only supports normal cache reuse.
      const fetchedAt = refreshAt - RT_CACHE_TTL_SECONDS * 1000;
      if (publishedAt <= fetchedAt) validUntil = publishedAt + MAX_TRIP_AGE_MS;
    }
    if (validUntil > Date.now()) updates = buildRealtimeMap(message.entity);
  }
  latest = { agencyId, refreshAt, validUntil, updates, retrying };
  return latest;
}

function retryAfterSeconds(response: Response): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds)
    ? Math.max(RT_CACHE_TTL_SECONDS, Math.min(seconds, 86400))
    : DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
}

async function loadSnapshot(agencyId: string): Promise<Snapshot> {
  // This synthetic URL lives in a named cache, separate from public HTML.
  const store = await globalThis.caches
    ?.open("tripupdates")
    .catch(() => undefined);
  const key = new Request(
    `https://transit.directory/.internal/tripupdates?agency=${encodeURIComponent(agencyId)}`,
  );
  if (store) {
    const hit = await store.match(key).catch(() => undefined);
    const refreshAt = Number(hit?.headers.get(REFRESH_AT_HEADER));
    if (hit && refreshAt > Date.now()) {
      const retrying = hit.headers.has(RETRY_HEADER);
      const buffer = await hit.arrayBuffer();
      return (
        freshSnapshot(agencyId, retrying) ??
        rememberSnapshot(agencyId, buffer, refreshAt, retrying)
      );
    }
  }

  const cached = freshSnapshot(agencyId);
  if (cached) return cached;

  const url = new URL("https://api.511.org/transit/tripupdates");
  url.searchParams.set("api_key", env.API_KEY_511);
  url.searchParams.set("agency", agencyId);
  let response: Response;
  let buffer: ArrayBuffer | null;
  try {
    response = await fetch(url);
    buffer = response.ok ? await response.arrayBuffer() : null;
  } catch {
    // A transport error can include the credential-bearing URL in its message.
    console.error("Failed to fetch realtime trip updates");
    return (
      freshSnapshot(agencyId) ??
      rememberSnapshot(
        agencyId,
        null,
        Date.now() + RT_CACHE_TTL_SECONDS * 1000,
        true,
      )
    );
  }
  const ttl =
    response.status === 429
      ? retryAfterSeconds(response)
      : RT_CACHE_TTL_SECONDS;
  const refreshAt = Date.now() + ttl * 1000;
  const retrying = response.status === 429 || response.status >= 500;
  // Another render may have completed its fetch while ours was in flight.
  // Keep its still-current snapshot and avoid writing over its edge entry.
  const concurrent = freshSnapshot(agencyId, retrying);
  if (concurrent) return concurrent;
  const snapshot = rememberSnapshot(agencyId, buffer, refreshAt, retrying);

  if (store) {
    // An empty 200 reliably caches the retry deadline for unavailable data.
    const body = snapshot.updates.size ? buffer : null;
    const cacheable = new Response(body, {
      headers: {
        "Cache-Control": `public, s-maxage=${ttl}`,
        [REFRESH_AT_HEADER]: String(refreshAt),
        "Content-Type": "application/x-protobuf",
      },
    });
    if (retrying) cacheable.headers.set(RETRY_HEADER, "1");
    await store.put(key, cacheable).catch(() => {});
  }
  return snapshot;
}

// The raw cache and the isolate's decoded map use the same absolute deadline.
// A render that reads a nearly expired edge entry cannot restart its TTL.
export const getRealtimeTripUpdates = cache(
  async (agencyId = "RG"): Promise<Map<string, RealtimeEntry>> => {
    if (!env.API_KEY_511) return new Map();
    let snapshot = freshSnapshot(agencyId);
    if (!snapshot) {
      try {
        snapshot = await loadSnapshot(agencyId);
      } catch {
        console.error("Failed to decode realtime trip updates");
        snapshot =
          freshSnapshot(agencyId) ??
          rememberSnapshot(
            agencyId,
            null,
            Date.now() + RT_CACHE_TTL_SECONDS * 1000,
          );
      }
    }
    return snapshot.validUntil > Date.now() ? snapshot.updates : new Map();
  },
);
