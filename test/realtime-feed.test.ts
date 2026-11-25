import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transit_realtime } from "../src/gtfs-realtime";

const { env } = vi.hoisted(() => ({ env: { API_KEY_511: "test-key" } }));
vi.mock("cloudflare:workers", () => ({ env }));

const start = Date.UTC(2026, 0, 1, 12, 0, 0);

function responseWithTrip(
  timestamp: number | null = Date.now() / 1000,
  hourlyLimit: string | null = "300",
) {
  const buffer = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", timestamp },
    entity: [
      { id: "1", tripUpdate: { trip: { tripId: "BA:123" }, delay: 60 } },
    ],
  }).finish();
  return new Response(new Uint8Array(buffer), {
    headers: hourlyLimit === null ? {} : { "RateLimit-Limit": hourlyLimit },
  });
}

async function freshSnapshotReader() {
  vi.resetModules();
  return (await import("../src/realtime-feed")).getRealtimeSnapshot;
}

async function freshIsolate() {
  vi.resetModules();
  return (await import("../src/realtime-feed")).getRealtimeTripUpdates;
}

describe("on-demand trip updates", () => {
  const entries = new Map<string, Response>();
  const store = {
    match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, value: Response) => {
      entries.set(key.url, value);
    }),
  };
  const fetchFeed = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    entries.clear();
    vi.clearAllMocks();
    fetchFeed.mockImplementation(async () => responseWithTrip());
    vi.stubGlobal("fetch", fetchFeed);
    vi.stubGlobal("caches", { open: async () => store });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    env.API_KEY_511 = "test-key";
  });

  it("reports a missing API key separately from a transport error", async () => {
    const read = await freshSnapshotReader();
    env.API_KEY_511 = "";
    expect((await read()).realtime).toEqual({
      status: "unconfigured",
      httpStatus: null,
      sourceUpdatedAt: null,
    });
    env.API_KEY_511 = "test-key";
    fetchFeed.mockRejectedValueOnce(new Error("offline"));
    expect((await read()).realtime).toEqual({
      status: "upstream_error",
      httpStatus: null,
      sourceUpdatedAt: null,
      nextCheckAt: new Date(start + 15_000).toISOString(),
    });
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 503])(
    "preserves upstream HTTP %d across isolates",
    async (httpStatus) => {
      fetchFeed.mockResolvedValueOnce(
        new Response(null, { status: httpStatus }),
      );
      const read = await freshSnapshotReader();
      const expected = {
        status: "upstream_error",
        httpStatus,
        sourceUpdatedAt: null,
        nextCheckAt: new Date(
          start + (httpStatus === 429 ? 300_000 : 15_000),
        ).toISOString(),
      };
      expect((await read()).realtime).toEqual(expected);
      const coldRead = await freshSnapshotReader();
      expect((await coldRead()).realtime).toEqual(expected);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Uint8Array(), new Uint8Array([255])])(
    "reports a malformed successful response across isolates",
    async (bytes) => {
      fetchFeed.mockResolvedValueOnce(new Response(bytes));
      const read = await freshSnapshotReader();
      const expected = {
        status: "invalid_payload",
        httpStatus: 200,
        sourceUpdatedAt: null,
        nextCheckAt: new Date(start + 66_000).toISOString(),
      };
      expect((await read()).realtime).toEqual(expected);
      const coldRead = await freshSnapshotReader();
      expect((await coldRead()).realtime).toEqual(expected);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
    },
  );

  it("distinguishes a fresh empty feed from an expired source through edge hits", async () => {
    const published = start - 85_000;
    const buf = transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: "2.0", timestamp: published / 1000 },
      entity: [],
    }).finish();
    fetchFeed.mockResolvedValueOnce(new Response(new Uint8Array(buf)));
    const read = await freshSnapshotReader();
    const expected = {
      status: "available",
      httpStatus: 200,
      sourceUpdatedAt: new Date(published).toISOString(),
      nextCheckAt: new Date(start + 66_000).toISOString(),
    };
    expect((await read()).realtime).toEqual(expected);
    vi.setSystemTime(start + 5_000);
    expect((await read()).realtime).toEqual({ ...expected, status: "stale" });
    const coldRead = await freshSnapshotReader();
    expect((await coldRead()).realtime).toEqual({
      ...expected,
      status: "stale",
    });
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("reports the response code and source time of retained predictions without attributing them to a cold isolate", async () => {
    const read = await freshSnapshotReader();
    const first = await read();
    vi.setSystemTime(start + 15_000);
    fetchFeed.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const degraded = await read();
    expect(degraded.updates).toBe(first.updates);
    expect(degraded.realtime).toEqual({
      status: "upstream_error",
      httpStatus: 429,
      sourceUpdatedAt: new Date(start).toISOString(),
      nextCheckAt: new Date(start + 315_000).toISOString(),
    });
    const coldRead = await freshSnapshotReader();
    const cold = await coldRead();
    expect(cold.realtime).toEqual({
      ...degraded.realtime,
      sourceUpdatedAt: null,
    });
    expect(cold.updates.size).toBe(0);
  });

  it("falls back to one upstream fetch when a cached response body cannot be read", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("cache stream lost"));
        },
      }),
      {
        headers: { "X-Transit-Refresh-At": String(start + 15_000) },
      },
    );
    store.match.mockResolvedValueOnce(broken);
    const read = await freshSnapshotReader();
    const result = await read();
    expect(result.realtime.status).toBe("available");
    expect(result.updates.size).toBe(1);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("requests the regional protobuf in a single GET", async () => {
    const load = await freshIsolate();
    await load();
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    const request = new Request(...fetchFeed.mock.calls[0]);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("agency")).toBe("RG");
    expect(request.headers.get("Accept")).toBe("application/x-google-protobuf");
  });

  it.each([
    [null, 66],
    ["invalid", 66],
    ["0", 66],
    ["60", 66],
    ["10", 400],
    ["1", 3600],
    ["300", 15],
  ] as const)(
    "paces the next on-demand check for hourly limit %s at %i seconds",
    async (limit, seconds) => {
      fetchFeed.mockResolvedValueOnce(responseWithTrip(start / 1000, limit));
      const read = await freshSnapshotReader();
      const nextCheckAt = new Date(start + seconds * 1000).toISOString();
      expect((await read()).realtime.nextCheckAt).toBe(nextCheckAt);
      vi.setSystemTime(start + seconds * 1000 - 1);
      const cold = await freshSnapshotReader();
      expect((await cold()).realtime.nextCheckAt).toBe(nextCheckAt);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start + seconds * 1000);
      expect((await cold()).realtime.status).toBe("available");
      expect(fetchFeed).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, start / 1000 + 120])(
    "expires unknown-age data at 90s across isolates even with a one-hour quota interval (%s)",
    async (timestamp) => {
      fetchFeed.mockResolvedValueOnce(responseWithTrip(timestamp, "1"));
      const read = await freshSnapshotReader();
      expect((await read()).updates.size).toBe(1);
      vi.setSystemTime(start + 89_999);
      const cold = await freshSnapshotReader();
      expect((await cold()).updates.size).toBe(1);
      vi.setSystemTime(start + 90_000);
      expect((await cold()).realtime.status).toBe("stale");
      expect((await cold()).updates.size).toBe(0);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
    },
  );

  it("reuses the decoded map across warm renders and the original deadline across cold ones", async () => {
    const load = await freshIsolate();
    const first = await load();
    expect(first.size).toBe(1);
    expect(await load()).toBe(first);
    expect(store.match).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 14_000);
    const coldLoad = await freshIsolate();
    expect(await coldLoad()).toEqual(first);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 15_000);
    expect((await coldLoad()).size).toBe(1);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    expect([...entries.keys()][0]).not.toContain("test-key");
  });

  it("drops expired source predictions without increasing polling", async () => {
    fetchFeed.mockResolvedValueOnce(responseWithTrip(start / 1000 - 85));
    const load = await freshIsolate();
    expect((await load()).size).toBe(1);
    vi.setSystemTime(start + 5_000);
    expect((await load()).size).toBe(0);
    const coldLoad = await freshIsolate();
    expect((await coldLoad()).size).toBe(0);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + 15_000);
    expect((await coldLoad()).size).toBe(1);
  });

  it.each([
    ["60", 60],
    [new Date(start + 60_000).toUTCString(), 60],
    ["unavailable", 300],
  ] as const)(
    "shares a 511 rate-limit cooldown (%s) and recovers at expiry",
    async (retryAfter, wait) => {
      fetchFeed.mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      );
      const load = await freshIsolate();
      expect((await load()).size).toBe(0);
      vi.setSystemTime(start + wait * 1000 - 1000);
      const coldLoad = await freshIsolate();
      expect((await coldLoad()).size).toBe(0);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start + wait * 1000);
      expect((await coldLoad()).size).toBe(1);
      expect(fetchFeed).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps last known predictions through a 429 only until the original source deadline", async () => {
    fetchFeed.mockResolvedValueOnce(responseWithTrip(start / 1000 - 30));
    const load = await freshIsolate();
    const first = await load();
    vi.setSystemTime(start + 15_000);
    fetchFeed.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "70" } }),
    );
    expect(await load()).toBe(first);
    vi.setSystemTime(start + 59_999);
    expect(await load()).toBe(first);
    vi.setSystemTime(start + 60_000);
    expect((await load()).size).toBe(0);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
    vi.setSystemTime(start + 85_000);
    const recovered = await load();
    expect(recovered.size).toBe(1);
    expect(recovered).not.toBe(first);
    expect(fetchFeed).toHaveBeenCalledTimes(3);
  });

  it("can use an existing warm prediction during another isolate's cached cooldown", async () => {
    const load = await freshIsolate();
    const first = await load();
    vi.setSystemTime(start + 15_000);
    fetchFeed.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const cold = await freshIsolate();
    expect((await cold()).size).toBe(0);
    expect(await load()).toBe(first);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it("keeps valid predictions after a network failure and clears them on an authoritative empty feed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = await freshIsolate();
    const first = await load();
    vi.setSystemTime(start + 15_000);
    fetchFeed.mockRejectedValueOnce(new Error("disconnected"));
    expect(await load()).toBe(first);
    vi.setSystemTime(start + 30_000);
    const empty = transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: "2.0", timestamp: Date.now() / 1000 },
      entity: [],
    }).finish();
    fetchFeed.mockResolvedValueOnce(
      new Response(new Uint8Array(empty), {
        headers: { "RateLimit-Limit": "300" },
      }),
    );
    expect((await load()).size).toBe(0);
    vi.setSystemTime(start + 45_000);
    fetchFeed.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await load()).size).toBe(0);
  });

  it.each([null, start / 1000 + 20])(
    "never extends a feed with an unreliable source timestamp (%s)",
    async (timestamp) => {
      fetchFeed.mockResolvedValueOnce(responseWithTrip(timestamp));
      const load = await freshIsolate();
      expect((await load()).size).toBe(1);
      vi.setSystemTime(start + 15_000);
      fetchFeed.mockResolvedValueOnce(new Response(null, { status: 503 }));
      expect((await load()).size).toBe(0);
    },
  );

  it("keeps a fallback scoped to its agency and clears it on a permanent error", async () => {
    const load = await freshIsolate();
    expect((await load("BA")).size).toBe(1);
    fetchFeed.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await load("CT")).size).toBe(0);
    expect((await load("BA")).size).toBe(1);
    vi.setSystemTime(start + 15_000);
    fetchFeed.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await load("BA")).size).toBe(0);
  });

  it("can serve fresh data when an edge cache read or write fails", async () => {
    store.match.mockRejectedValueOnce(new Error("unavailable"));
    store.put.mockRejectedValueOnce(new Error("unavailable"));
    const load = await freshIsolate();
    expect((await load()).size).toBe(1);
    expect((await load()).size).toBe(1);
    expect(fetchFeed).toHaveBeenCalledTimes(1);
  });

  it("skips edge and upstream requests without a 511 key", async () => {
    env.API_KEY_511 = "";
    const load = await freshIsolate();
    expect((await load()).size).toBe(0);
    expect(store.match).not.toHaveBeenCalled();
    expect(fetchFeed).not.toHaveBeenCalled();
  });

  it.each(["network", "protobuf"])(
    "backs off after a %s error and keeps credentials out of logs",
    async (failure) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "network") {
        fetchFeed.mockRejectedValueOnce(
          new Error("https://api.511.org/?api_key=test-key"),
        );
      } else {
        fetchFeed.mockResolvedValueOnce(new Response(new Uint8Array([255])));
      }
      const load = await freshIsolate();
      expect((await load()).size).toBe(0);
      expect((await load()).size).toBe(0);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("test-key");
      vi.setSystemTime(start + (failure === "network" ? 15_000 : 66_000));
      expect((await load()).size).toBe(1);
    },
  );

  it("keeps the current snapshot when an older concurrent fetch finishes late", async () => {
    const first = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    fetchFeed.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const load = await freshIsolate();
    const pending = load();
    await started.promise;
    const current = await load();
    first.resolve(responseWithTrip(start / 1000 - 100));
    expect(await pending).toBe(current);
    expect(await load()).toBe(current);
    expect(store.put).toHaveBeenCalledTimes(1);
  });
});
