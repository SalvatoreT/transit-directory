import { describe, expect, it } from "vitest";
import {
  extractTripUpdateState,
  stripAgencyPrefix,
} from "../src/realtime-utils";

describe("stripAgencyPrefix", () => {
  it("removes the regional agency prefix", () => {
    expect(stripAgencyPrefix("BA:1841778")).toBe("1841778");
  });

  it("leaves unprefixed ids untouched", () => {
    expect(stripAgencyPrefix("1841778")).toBe("1841778");
  });

  it("strips only the first prefix segment", () => {
    expect(stripAgencyPrefix("SF:A:B")).toBe("A:B");
  });
});

describe("extractTripUpdateState", () => {
  it("returns null when the entity has no trip update or trip id", () => {
    expect(extractTripUpdateState({ id: "1" })).toBeNull();
    expect(
      extractTripUpdateState({ id: "1", tripUpdate: { trip: {} } }),
    ).toBeNull();
  });

  it("uses the trip-level delay and strips the agency prefix", () => {
    const state = extractTripUpdateState({
      id: "1",
      tripUpdate: { trip: { tripId: "BA:123" }, delay: 120 },
    });
    expect(state).toEqual({ tripId: "123", delay: 120, status: "SCHEDULED" });
  });

  it("falls back to the first stop time update's arrival delay", () => {
    const state = extractTripUpdateState({
      id: "1",
      tripUpdate: {
        trip: { tripId: "123" },
        stopTimeUpdate: [
          { arrival: { delay: 45 } },
          { arrival: { delay: 99 } },
        ],
      },
    });
    expect(state?.delay).toBe(45);
  });

  it("falls back to the departure delay when arrival has none", () => {
    const state = extractTripUpdateState({
      id: "1",
      tripUpdate: {
        trip: { tripId: "123" },
        stopTimeUpdate: [{ departure: { delay: -30 } }],
      },
    });
    expect(state?.delay).toBe(-30);
  });

  it("maps schedule relationships to statuses", () => {
    const statusFor = (rel: number) =>
      extractTripUpdateState({
        id: "1",
        tripUpdate: { trip: { tripId: "1", scheduleRelationship: rel } },
      })?.status;
    expect(statusFor(0)).toBe("SCHEDULED");
    expect(statusFor(1)).toBe("ADDED");
    expect(statusFor(2)).toBe("UNSCHEDULED");
    expect(statusFor(3)).toBe("CANCELED");
  });
});
