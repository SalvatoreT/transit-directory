import { env } from "cloudflare:workers";
import { cache } from "react";
import { transit_realtime } from "./gtfs-realtime";
import {
  buildRealtimeMap,
  MAX_TRIP_AGE_MS,
  type RealtimeEntry,
} from "./realtime-utils";

const RT_CACHE_TTL_SECONDS = 15;
const DEFAULT_HOURLY_LIMIT = 60;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 300;
const FETCHED_AT_HEADER = "X-Transit-Fetched-At";
const REFRESH_AT_HEADER = "X-Transit-Refresh-At";
const RETRY_HEADER = "X-Transit-Retry";
const STATUS_HEADER = "X-Transit-Status";
const HTTP_STATUS_HEADER = "X-Transit-HTTP-Status";
const PUBLISHED_HEADER = "X-Transit-Source-Updated-At";

export interface RealtimeFeedStatus {
  status:
    | "available"
    | "stale"
    | "unconfigured"
    | "upstream_error"
    | "invalid_payload"
    | "not_requested";
  sourceUpdatedAt: string | null;
  httpStatus: number | null;
  // Earliest on-demand refresh at this cache location.
  nextCheckAt?: string;
}

interface Snapshot {
  agencyId: string;
  refreshAt: number;
  validUntil: number;
  retrying: boolean;
  updates: Map<string, RealtimeEntry>;
  realtime: RealtimeFeedStatus;
}

// Keep only completed data across requests. Streams and in-flight fetch
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
  refreshAt: number,
  buffer: ArrayBuffer | null,
  realtime: RealtimeFeedStatus,
  retrying = false,
  fetchedAt = Date.now(),
): Snapshot {
  realtime.nextCheckAt = new Date(refreshAt).toISOString();
  if (
    retrying &&
    latest?.agencyId === agencyId &&
    latest.validUntil > Date.now() &&
    latest.updates.size
  ) {
    latest = {
      ...latest,
      refreshAt,
      retrying,
      realtime: {
        ...realtime,
        sourceUpdatedAt: latest.realtime.sourceUpdatedAt,
      },
    };
    return latest;
  }
  let message: transit_realtime.FeedMessage | undefined;
  if (buffer !== null) {
    try {
      message = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
      if (Object.hasOwn(message.header, "timestamp")) {
        const published = new Date(Number(message.header.timestamp) * 1000);
        if (Number.isFinite(published.getTime()))
          realtime.sourceUpdatedAt = published.toISOString();
      }
    } catch {
      realtime.status = "invalid_payload";
    }
  }
  // Empty cache entries carry the same publication time as the original
  // protobuf. Missing and future timestamps support normal cache reuse only.
  const publishedAt = Date.parse(realtime.sourceUpdatedAt ?? "");
  const validUntil =
    publishedAt <= fetchedAt
      ? publishedAt + MAX_TRIP_AGE_MS
      : Math.min(refreshAt, fetchedAt + MAX_TRIP_AGE_MS);
  if (realtime.status === "available" && validUntil <= Date.now())
    realtime.status = "stale";
  const updates =
    message && realtime.status === "available"
      ? buildRealtimeMap(message.entity)
      : new Map<string, RealtimeEntry>();
  latest = { agencyId, refreshAt, validUntil, updates, retrying, realtime };
  return latest;
}

function retryAfterSeconds(response: Response): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  // Cache-Control delta-seconds are supported through signed 32-bit integers.
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Math.max(RT_CACHE_TTL_SECONDS, Math.min(seconds, 2_147_483_647))
    : DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
}

function refreshIntervalSeconds(response: Response): number {
  if (response.status === 429) return retryAfterSeconds(response);
  if (!response.ok) return RT_CACHE_TTL_SECONDS;
  const header = response.headers.get("RateLimit-Limit")?.trim() ?? "";
  const reported = /^\d+$/.test(header) ? Number(header) : 0;
  const limit =
    Number.isSafeInteger(reported) && reported > 0
      ? reported
      : DEFAULT_HOURLY_LIMIT;
  // Leave room for up to five static imports, using at most 10% of the quota.
  const reserve = Math.min(5, Math.floor(limit / 10));
  return Math.max(RT_CACHE_TTL_SECONDS, Math.ceil(3600 / (limit - reserve)));
}

async function readCachedSnapshot(
  store: Cache,
  key: Request,
  agencyId: string,
): Promise<Snapshot | undefined> {
  const hit = await store.match(key);
  const refreshAt = Number(hit?.headers.get(REFRESH_AT_HEADER));
  if (!hit || !(refreshAt > Date.now())) return;
  // Entries from before quota-aware pacing used a fixed 15-second success TTL.
  const fetchedAt =
    Number(hit.headers.get(FETCHED_AT_HEADER)) ||
    refreshAt - RT_CACHE_TTL_SECONDS * 1000;
  const retrying = hit.headers.has(RETRY_HEADER);
  const buffer = await hit.arrayBuffer();
  // Entries written by older deployments only carried the retry deadline.
  const status = hit.headers.get(STATUS_HEADER) as
    | RealtimeFeedStatus["status"]
    | null;
  const realtime = {
    status: status ?? (buffer.byteLength ? "available" : "upstream_error"),
    httpStatus: Number(hit.headers.get(HTTP_STATUS_HEADER)) || null,
    sourceUpdatedAt: hit.headers.get(PUBLISHED_HEADER),
  };
  return (
    freshSnapshot(agencyId, retrying) ??
    rememberSnapshot(
      agencyId,
      refreshAt,
      buffer.byteLength ? buffer : null,
      realtime,
      retrying,
      fetchedAt,
    )
  );
}

async function loadSnapshot(agencyId: string): Promise<Snapshot> {
  const store = await globalThis.caches
    ?.open("tripupdates")
    .catch(() => undefined);
  const key = new Request(
    `https://transit.directory/.internal/tripupdates?agency=${encodeURIComponent(agencyId)}`,
  );
  if (store) {
    const hit = await readCachedSnapshot(store, key, agencyId).catch(
      () => undefined,
    );
    if (hit) return hit;
  }
  const cached = freshSnapshot(agencyId);
  if (cached) return cached;
  const url = new URL("https://api.511.org/transit/tripupdates");
  url.searchParams.set("api_key", env.API_KEY_511);
  url.searchParams.set("agency", agencyId);
  let response: Response;
  let buffer: ArrayBuffer | null;
  let httpStatus: number | null = null;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/x-google-protobuf" },
    });
    httpStatus = response.status;
    buffer = response.ok ? await response.arrayBuffer() : null;
  } catch {
    // A transport error can include the credential-bearing URL in its message.
    const refreshAt = Date.now() + RT_CACHE_TTL_SECONDS * 1000;
    return (
      freshSnapshot(agencyId) ??
      rememberSnapshot(
        agencyId,
        refreshAt,
        null,
        { status: "upstream_error", httpStatus, sourceUpdatedAt: null },
        true,
      )
    );
  }
  const ttl = refreshIntervalSeconds(response);
  const fetchedAt = Date.now();
  const refreshAt = fetchedAt + ttl * 1000;
  const retrying = response.status === 429 || response.status >= 500;
  // A concurrent render may already have installed a newer snapshot.
  const concurrent = freshSnapshot(agencyId, retrying);
  if (concurrent) return concurrent;
  const snapshot = rememberSnapshot(
    agencyId,
    refreshAt,
    buffer,
    {
      status: response.ok ? "available" : "upstream_error",
      httpStatus,
      sourceUpdatedAt: null,
    },
    retrying,
    fetchedAt,
  );

  if (store) {
    // Empty 200 entries share the cooldown, source age and failure outcome.
    const body = snapshot.updates.size ? buffer : null;
    const cacheable = new Response(body, {
      headers: {
        "Cache-Control": `public, s-maxage=${ttl}`,
        [REFRESH_AT_HEADER]: String(refreshAt),
        [FETCHED_AT_HEADER]: String(fetchedAt),
        [STATUS_HEADER]: snapshot.realtime.status,
        [HTTP_STATUS_HEADER]: String(response.status),
        "Content-Type": "application/x-protobuf",
      },
    });
    if (retrying) cacheable.headers.set(RETRY_HEADER, "1");
    // Predictions retained only in this isolate do not accompany an edge error.
    if (response.ok && snapshot.realtime.sourceUpdatedAt)
      cacheable.headers.set(
        PUBLISHED_HEADER,
        snapshot.realtime.sourceUpdatedAt,
      );
    await store.put(key, cacheable).catch(() => {});
  }
  return snapshot;
}

export const getRealtimeSnapshot = cache(
  async (agencyId = "RG"): Promise<Pick<Snapshot, "updates" | "realtime">> => {
    if (!env.API_KEY_511)
      return {
        updates: new Map(),
        realtime: {
          status: "unconfigured",
          httpStatus: null,
          sourceUpdatedAt: null,
        },
      };
    const snapshot = freshSnapshot(agencyId) ?? (await loadSnapshot(agencyId));
    if (snapshot.validUntil > Date.now())
      return { updates: snapshot.updates, realtime: snapshot.realtime };
    return {
      updates: new Map(),
      realtime:
        snapshot.realtime.status === "available"
          ? { ...snapshot.realtime, status: "stale" }
          : snapshot.realtime,
    };
  },
);

export async function getRealtimeTripUpdates(
  agencyId = "RG",
): Promise<Map<string, RealtimeEntry>> {
  return (await getRealtimeSnapshot(agencyId)).updates;
}
