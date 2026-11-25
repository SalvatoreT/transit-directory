import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRealtimeMap,
  mergeDeparturesRealtime,
  mergeTripStopsRealtime,
} from "../src/db-queries";
import type { transit_realtime } from "../src/gtfs-realtime";

const todayNoon = Date.UTC(2026, 3, 5, 19) / 1000;
const start = todayNoon - 43200;
const window = { todayNoon, currentSeconds: 3000, endSeconds: 5000 };

function stop(seq: number, trip_id = "123") {
  return {
    trip_id,
    stop_id: String(seq),
    stop_sequence: seq,
    arrival_time: 3500 + seq * 100,
    departure_time: 3510 + seq * 100,
  };
}

function build(
  trip: transit_realtime.ITripDescriptor,
  fields: Partial<transit_realtime.ITripUpdate> = {},
) {
  return { id: "e", tripUpdate: { trip, ...fields } };
}

describe("regional predictions", () => {
  afterEach(() => vi.useRealTimers());

  it("expires individual operator updates even while the regional snapshot is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(todayNoon * 1000);
    const rt = buildRealtimeMap([
      build({ tripId: "BA:old" }, { timestamp: todayNoon - 91, delay: 80 }),
      build(
        { tripId: "BA:expiring" },
        { timestamp: todayNoon - 85, delay: 30 },
      ),
      build({ tripId: "BA:unknown-age" }, { delay: 60 }),
    ]);
    const rows = ["old", "expiring", "unknown-age"].map((id, i) =>
      stop(i + 1, id),
    );
    const board = () =>
      mergeDeparturesRealtime(rows, rt, "BA", window).map((r) => r.delay);
    expect(rt.has("BA:old")).toBe(false);
    expect(board()).toEqual([null, 30, 60]);
    vi.setSystemTime((todayNoon + 5) * 1000);
    expect(board()).toEqual([null, null, 60]);
  });

  it("handles regional static stop ids and unordered prediction boundaries", () => {
    const rows = [1, 2, 3, 4].map((seq) => ({
      ...stop(seq),
      stop_id: `BA:${seq}`,
    }));
    const rt = buildRealtimeMap([
      build(
        { tripId: "BA:123" },
        {
          stopTimeUpdate: [
            { stopId: "BA:3", departure: { delay: 0 } },
            { stopId: "BA:1", departure: { delay: 111 } },
          ],
        },
      ),
    ]);
    expect(
      mergeTripStopsRealtime(rows, "BA:123", rt, "RG", todayNoon).map(
        (r) => r.delay,
      ),
    ).toEqual([111, 111, 0, 0]);
  });

  it("matches the static feed operator and service date, including ids with embedded colons", () => {
    const rt = buildRealtimeMap([
      build({ tripId: "CT:X:1" }, { delay: 12 }),
      build({ tripId: "BA:X:1", startDate: "20260405" }, { delay: 51 }),
      build({ tripId: "BA:X:1", startDate: "20260406" }, { delay: 60 }),
      build({ tripId: "X:1" }, { delay: 90 }),
    ]);
    const rows = [stop(1, "X:1")];
    const board = (source: string) =>
      mergeDeparturesRealtime(rows, rt, source, window)[0];
    expect(board("BA").delay).toBe(51);
    expect(board("CT").delay).toBe(12);
    expect(board("AC").delay).toBeNull();
    expect(rows[0]).not.toHaveProperty("delay");
    expect(
      mergeTripStopsRealtime(rows, "BA:X:1", rt, "RG", todayNoon)[0].delay,
    ).toBe(51);
  });

  it("uses the correct absolute arrival and departure at a stop, and propagates its departure delay forward", () => {
    const rt = buildRealtimeMap([
      build(
        { tripId: "BA:123" },
        {
          delay: 0,
          stopTimeUpdate: [
            {
              stopSequence: 2,
              arrival: { time: start + stop(2).arrival_time + 45, delay: -30 },
              departure: { time: start + stop(2).departure_time + 120 },
            },
            { stopSequence: 4, scheduleRelationship: 1 },
            { stopSequence: 6, scheduleRelationship: 2 },
            { stopId: "BA:8", departure: { delay: 0 } },
          ],
        },
      ),
    ]);
    const rows = Array.from({ length: 9 }, (_, i) => stop(i + 1));
    const stops = mergeTripStopsRealtime(rows, "123", rt, "BA", todayNoon);
    expect(stops.map((r) => r.delay)).toEqual([
      0,
      45,
      120,
      null,
      120,
      null,
      null,
      0,
      0,
    ]);
    expect(stops[1].departure_delay).toBe(120);
    expect(stops[3].realtime_status).toBe("SKIPPED");
    const departures = mergeDeparturesRealtime(rows, rt, "BA", window);
    expect(departures.find((r) => r.stop_sequence === 2)?.delay).toBe(120);
  });

  it("never applies a later stop's delay backward, or infers a delay from a partial board with an unlocatable update", () => {
    const rt = buildRealtimeMap([
      build(
        { tripId: "BA:123" },
        { stopTimeUpdate: [{ stopSequence: 4, departure: { delay: 130 } }] },
      ),
    ]);
    const rows = [stop(3), stop(5)];
    expect(
      mergeDeparturesRealtime(rows, rt, "BA", window).map((r) => r.delay),
    ).toEqual([null, 130]);

    const partial = buildRealtimeMap([
      build(
        { tripId: "BA:123" },
        {
          delay: 20,
          stopTimeUpdate: [
            { stopId: "BA:some-other-stop", scheduleRelationship: 2 },
            { stopId: "BA:5", departure: { delay: 45 } },
          ],
        },
      ),
    ]);
    expect(
      mergeDeparturesRealtime(rows, partial, "BA", window).map((r) => r.delay),
    ).toEqual([null, 45]);
  });

  it("shows cancellations, excludes deleted or already departed trips, and orders other rows by ETA", () => {
    const rt = buildRealtimeMap([
      build({ tripId: "BA:gone", scheduleRelationship: 7 }),
      build({ tripId: "BA:cancel", scheduleRelationship: 3 }, { delay: 80 }),
      build({ tripId: "BA:early" }, { delay: -900 }),
      build({ tripId: "BA:late" }, { delay: 300 }),
    ]);
    const rows = ["gone", "cancel", "early", "late", "scheduled"].map((id, i) =>
      stop(i + 1, id),
    );
    const board = mergeDeparturesRealtime(rows, rt, "BA", window);
    expect(board.map((r) => r.trip_id)).toEqual([
      "cancel",
      "scheduled",
      "late",
    ]);
    expect(board[0]).toMatchObject({
      delay: null,
      realtime_status: "CANCELED",
    });
    expect(mergeTripStopsRealtime(rows, "gone", rt, "BA", todayNoon)).toEqual(
      [],
    );
  });
});
