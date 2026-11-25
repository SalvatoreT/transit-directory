import { describe, expect, it } from "vitest";
import { buildRealtimeMap } from "../src/realtime-utils";
import { transit_realtime } from "../src/gtfs-realtime";

describe("decoded trip updates", () => {
  it("distinguishes an omitted protobuf delay from an explicit zero", () => {
    const bytes = transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: "2.0" },
      entity: [
        { id: "1", tripUpdate: { trip: { tripId: "BA:unknown" } } },
        { id: "2", tripUpdate: { trip: { tripId: "BA:on-time" }, delay: 0 } },
        { id: "3", tripUpdate: { trip: { tripId: "BA:early" }, delay: -30 } },
      ],
    }).finish();
    const map = buildRealtimeMap(
      transit_realtime.FeedMessage.decode(bytes).entity,
    );
    expect(map.get("BA:unknown")?.delay).toBeNull();
    expect(map.get("BA:on-time")?.delay).toBe(0);
    expect(map.get("BA:early")?.delay).toBe(-30);
  });

  it("skips missing trip ids and keeps duplicated vehicles from overwriting a scheduled trip", () => {
    const entities = [
      { id: "1" },
      { id: "2", tripUpdate: { trip: {} } },
      { id: "3", tripUpdate: { trip: { tripId: "BA:123" }, delay: 45 } },
      {
        id: "4",
        tripUpdate: {
          trip: { tripId: "BA:123", scheduleRelationship: 6 },
          delay: -30,
        },
      },
    ];
    const map = buildRealtimeMap(entities);
    expect(map.size).toBe(1);
    expect(map.get("BA:123")?.delay).toBe(45);
  });
});
