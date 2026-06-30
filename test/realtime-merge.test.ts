import { describe, expect, it } from "vitest";
import {
  buildRealtimeMap,
  mergeDeparturesRealtime,
  mergeTripStopsRealtime,
  type RealtimeEntry,
} from "../src/db-queries";

describe("buildRealtimeMap", () => {
  it("keys entries by the prefix-stripped trip id", () => {
    const map = buildRealtimeMap([
      { id: "1", tripUpdate: { trip: { tripId: "RG:123" }, delay: 60 } },
    ]);
    expect(map.get("123")).toEqual({ delay: 60, status: "SCHEDULED" });
    expect(map.has("RG:123")).toBe(false);
  });

  it("skips entities without a usable trip update", () => {
    const map = buildRealtimeMap([
      { id: "1" },
      { id: "2", tripUpdate: { trip: {} } },
    ]);
    expect(map.size).toBe(0);
  });

  it("lets the last entity win on duplicate trip ids", () => {
    const map = buildRealtimeMap([
      { id: "1", tripUpdate: { trip: { tripId: "9" }, delay: 30 } },
      { id: "2", tripUpdate: { trip: { tripId: "9" }, delay: 90 } },
    ]);
    expect(map.get("9")?.delay).toBe(90);
  });
});

describe("mergeDeparturesRealtime", () => {
  const rt = new Map<string, RealtimeEntry>([
    ["123", { delay: 120, status: "SCHEDULED" }],
  ]);

  it("attaches delay and status for matching trips, null otherwise", () => {
    const rows = [
      { trip_id: "123", departure_time: 100 },
      { trip_id: "999", departure_time: 200 },
    ];
    const merged = mergeDeparturesRealtime(rows, rt);
    expect(merged[0]).toMatchObject({
      trip_id: "123",
      delay: 120,
      realtime_status: "SCHEDULED",
    });
    expect(merged[1]).toMatchObject({
      trip_id: "999",
      delay: null,
      realtime_status: null,
    });
  });

  it("does not mutate the input rows", () => {
    const rows = [{ trip_id: "123" }];
    mergeDeparturesRealtime(rows, rt);
    expect(rows[0]).not.toHaveProperty("delay");
  });
});

describe("mergeTripStopsRealtime", () => {
  it("applies the trip's single delay to every stop row", () => {
    const rt = new Map<string, RealtimeEntry>([
      ["555", { delay: -30, status: "SCHEDULED" }],
    ]);
    const rows = [{ stop_sequence: 1 }, { stop_sequence: 2 }];
    const merged = mergeTripStopsRealtime(rows, "555", rt);
    expect(merged.map((r) => r.delay)).toEqual([-30, -30]);
  });

  it("uses null delay when the trip has no realtime entry", () => {
    const rows = [{ stop_sequence: 1 }];
    const merged = mergeTripStopsRealtime(rows, "555", new Map());
    expect(merged[0].delay).toBeNull();
  });
});
