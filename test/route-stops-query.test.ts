import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { ROUTE_STOPS_SQL } from "../src/db-queries";

it("picks the longest trip per direction and keeps stop sequence order", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("../migrations/0001_initial_schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`
      INSERT INTO feed_source(source_name) VALUES ('test');
      INSERT INTO feed_version(feed_version_id, feed_source_id) VALUES (1, 1);
      INSERT INTO routes(route_pk, feed_version_id, route_id, route_type)
        VALUES (1, 1, 'rail', 2), (2, 1, 'other', 2);
      INSERT INTO stops(stop_pk, feed_version_id, stop_id, stop_name, stop_lat, stop_lon)
        VALUES (1, 1, 'A', 'First', 0, 0), (2, 1, 'B', 'Second', 0, 0);
      INSERT INTO trips(trip_pk, feed_version_id, trip_id, route_pk, service_id, direction_id, trip_headsign)
        VALUES (1, 1, 'short', 1, 'day', 0, 'Short'),
               (2, 1, 'long', 1, 'day', 0, 'Long'),
               (3, 1, 'tied', 1, 'day', 0, 'Tied'),
               (4, 1, 'back', 1, 'day', NULL, 'Back'),
               (5, 1, 'empty', 1, 'day', 1, 'Empty'),
               (6, 1, 'other', 2, 'day', 1, 'Other');
      INSERT INTO stop_times(trip_pk, stop_pk, stop_sequence)
        VALUES (1, 2, 900), (2, 2, 20), (2, 1, 5),
               (3, 1, 1), (3, 2, 2), (4, 2, 1), (6, 1, 1);
    `);
    const result = db.prepare(ROUTE_STOPS_SQL).all(1);
    const stops = result.map((r) => [
      r.stop_id,
      r.stop_sequence,
      r.direction_id,
      r.trip_headsign,
    ]);
    expect(stops[0]).toEqual(["B", 1, null, "Back"]);
    // Either tied longest trip may represent direction 0. Metadata and the
    // stops must all agree on the selected trip.
    expect([
      [
        ["A", 5, 0, "Long"],
        ["B", 20, 0, "Long"],
      ],
      [
        ["A", 1, 0, "Tied"],
        ["B", 2, 0, "Tied"],
      ],
    ]).toContainEqual(stops.slice(1));
  } finally {
    db.close();
  }
});

const { all } = vi.hoisted(() => ({ all: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  env: {
    gtfs_data: {
      withSession: () => ({ prepare: () => ({ bind: () => ({ all }) }) }),
    },
  },
}));

it("reuses a populated route briefly and misses on route or version changes", async () => {
  const { getRouteStops } = await import("../src/db");
  vi.useFakeTimers();
  try {
    all.mockResolvedValueOnce({ results: [] });
    all.mockResolvedValue({ results: [{ stop_id: "A" }] });
    expect(await getRouteStops(1)).toEqual([]);
    await getRouteStops(1);
    await getRouteStops(1);
    expect(all).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60_000);
    await getRouteStops(1);
    expect(all).toHaveBeenCalledTimes(3);
    await getRouteStops(2);
    await getRouteStops(1);
    expect(all).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});
