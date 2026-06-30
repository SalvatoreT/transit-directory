import { env } from "cloudflare:workers";
import { cache } from "react";
import { transit_realtime } from "./gtfs-realtime";
import { buildRealtimeMap, type RealtimeEntry } from "./db-queries";

// How long a fetched GTFS-RT payload is reused before we hit 511 again. The
// raw protobuf bytes are cached in the Cloudflare Cache API, so concurrent and
// sequential page renders share one upstream fetch instead of polling every
// ~15s in the background.
const RT_CACHE_TTL_SECONDS = 15;

// Synthetic, key-only URL: keeps the 511 api_key out of the cache key while
// still varying by agency.
function rtCacheKey(agencyId: string): Request {
  return new Request(`https://rt.internal/tripupdates?agency=${agencyId}`, {
    method: "GET",
  });
}

// The Workers Cache API lives at caches.default. It is undefined in vitest and
// a transparent no-op on workers.dev previews (only real zones cache); both
// degrade to a direct upstream fetch. lib.dom's CacheStorage typing shadows
// .default, hence the cast.
function getCacheStore(): Cache | undefined {
  const cs = (globalThis as { caches?: { default?: Cache } }).caches;
  return cs?.default;
}

async function fetchRawFeed(agencyId: string): Promise<ArrayBuffer | null> {
  const store = getCacheStore();
  if (store) {
    const hit = await store.match(rtCacheKey(agencyId));
    if (hit) return await hit.arrayBuffer();
  }

  const url = `https://api.511.org/transit/tripupdates?api_key=${env.API_KEY_511}&agency=${agencyId}`;
  const response = await fetch(url);
  // Rate limited (429) or any error: skip realtime for this render rather than
  // breaking the page.
  if (!response.ok) return null;

  const buffer = await response.arrayBuffer();

  if (store) {
    const cacheable = new Response(buffer.slice(0), {
      headers: {
        "Cache-Control": `public, s-maxage=${RT_CACHE_TTL_SECONDS}`,
        "Content-Type": "application/x-protobuf",
      },
    });
    await store.put(rtCacheKey(agencyId), cacheable).catch(() => {});
  }

  return buffer;
}

// Fetches (and caches) the regional GTFS-RT TripUpdates feed and returns a
// trip_id -> {delay, status} map. Wrapped in React cache() so a single render
// decodes the payload at most once. Never throws: any failure yields an empty
// map so pages still render their static schedule.
export const getRealtimeTripUpdates = cache(
  async (agencyId = "RG"): Promise<Map<string, RealtimeEntry>> => {
    try {
      const buffer = await fetchRawFeed(agencyId);
      if (!buffer) return new Map();
      const message = transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer),
      );
      return buildRealtimeMap(message.entity || []);
    } catch (err) {
      console.error("Failed to load realtime trip updates:", err);
      return new Map();
    }
  },
);
