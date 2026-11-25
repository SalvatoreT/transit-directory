import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transit_realtime } from "../src/gtfs-realtime";

const { env } = vi.hoisted(() => ({ env: { API_KEY_511: "test-key" } }));
vi.mock("cloudflare:workers", () => ({ env }));

const start = Date.UTC(2026, 0, 1, 12, 0, 0);

function responseWithTrip(timestamp: number | null = Date.now() / 1000) {
  const buffer = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", timestamp },
    entity: [
      { id: "1", tripUpdate: { trip: { tripId: "BA:123" }, delay: 60 } },
    ],
  }).finish();
  return new Response(new Uint8Array(buffer));
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
  const fetchFeed = vi.fn<() => Promise<Response>>();

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

  it.each(["60", new Date(start + 60_000).toUTCString(), "unavailable"])(
    "shares a 511 rate-limit cooldown (%s) and recovers at expiry",
    async (retryAfter) => {
      fetchFeed.mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      );
      const load = await freshIsolate();
      expect((await load()).size).toBe(0);
      vi.setSystemTime(start + 59_000);
      const coldLoad = await freshIsolate();
      expect((await coldLoad()).size).toBe(0);
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start + 60_000);
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
    fetchFeed.mockResolvedValueOnce(new Response(new Uint8Array(empty)));
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
      vi.setSystemTime(start + 15_000);
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
