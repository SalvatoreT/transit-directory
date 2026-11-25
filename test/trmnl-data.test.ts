import { afterEach, expect, it, vi } from "vitest";
import {
  getAgency,
  getDepartures,
  getStop,
  getStops,
  type DeparturesData,
} from "../src/db";
import { getTrmnlData } from "../src/lib/trmnl/data";

vi.mock("../src/db", () => ({
  getAgency: vi.fn(),
  getDepartures: vi.fn(),
  getStop: vi.fn(),
  getStops: vi.fn(),
}));

afterEach(() => vi.useRealTimers());

it("uses the operator's predicted times and distinguishes disruptions from on-time trips", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T17:00:00Z"));
  vi.mocked(getAgency).mockResolvedValue({
    agency_id: "Caltrain",
    source_name: "CT",
    agency_name: "Caltrain",
    agency_pk: 1,
    agency_timezone: "America/Los_Angeles",
    feed_version_id: 2,
  });
  vi.mocked(getStop).mockResolvedValue({
    stop_pk: 7,
    stop_name: "Station",
  } as NonNullable<Awaited<ReturnType<typeof getStop>>>);
  vi.mocked(getStops).mockResolvedValue([]);
  const scheduled = {
    departure_time: 36000,
    delay: null,
    route_id: "Local",
  } as DeparturesData;
  vi.mocked(getDepartures).mockResolvedValue([
    { ...scheduled, delay: -120 },
    scheduled,
    { ...scheduled, delay: 60, realtime_status: "CANCELED" },
    { ...scheduled, realtime_status: "SKIPPED" },
    { ...scheduled, delay: 300 },
  ]);

  const data = await getTrmnlData("Caltrain", "station-id", "My station");
  expect(getDepartures).toHaveBeenCalledWith(
    expect.objectContaining({ stopPks: [7], currentSeconds: 32400 }),
    "CT",
  );
  expect([data.stopName, data.departureCount]).toEqual(["My station", 5]);
  expect(data.departures.map((d) => [d.time, d.delayText])).toEqual([
    ["09:58", "-2 min early"],
    ["10:00", "Sched."],
    ["10:00", "Canceled"],
    ["10:00", "Skipped"],
    ["10:05", "+5 min late"],
  ]);
});
