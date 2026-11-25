import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RoutePage from "../app/a/[agency_id]/r/[route_id]/page";
import {
  getAgency,
  getDepartures,
  getRoute,
  getRouteStops,
  type DeparturesData,
  type RouteStopData,
} from "../src/db";

vi.mock("../src/db", () => ({
  getAgency: vi.fn(),
  getDepartures: vi.fn(),
  getRoute: vi.fn(),
  getRouteStops: vi.fn(),
}));

function routeStop(
  direction_id: number | null,
  trip_headsign: string,
): RouteStopData {
  return {
    stop_id: "51188",
    stop_name: "College Av & Rockridge BART",
    direction_id,
    trip_headsign,
  } as RouteStopData;
}

function departure(
  trip_id: string,
  direction_id: number | null,
  trip_headsign: string,
  departure_time: number,
  stop_id = "51188",
): DeparturesData {
  return {
    trip_id,
    direction_id,
    trip_headsign,
    departure_time,
    stop_id,
    stop_sequence: 1,
    delay: null,
  } as DeparturesData;
}

async function renderTripGroups() {
  const page = await RoutePage({
    params: Promise.resolve({ agency_id: "AC", route_id: "51B" }),
  });
  const html = renderToStaticMarkup(page);
  return Array.from(
    html.matchAll(/<section\b[^>]*>(.*?)<\/section>/gs),
    ([, section]) => ({
      heading: section.match(/<h2>(.*?)<\/h2>/)?.[1],
      trips: Array.from(
        section.matchAll(/href="\/a\/AC\/t\/([^"?]+)\?stop=/g),
        ([, trip]) => trip,
      ),
    }),
  );
}

describe("51B route departures", () => {
  beforeEach(() => {
    vi.mocked(getAgency).mockResolvedValue({
      agency_name: "AC Transit",
      source_name: "AC",
      agency_id: "AC",
      agency_pk: 1,
      agency_timezone: "America/Los_Angeles",
      feed_version_id: 1,
    });
    vi.mocked(getRoute).mockResolvedValue({
      route_pk: 51,
      route_short_name: "51B",
    } as Awaited<ReturnType<typeof getRoute>>);
  });

  it("takes the first three matching departures per direction at a shared stop", async () => {
    vi.mocked(getRouteStops).mockResolvedValue([
      routeStop(0, "Rockridge BART"),
      routeStop(1, "Berkeley Marina"),
    ]);
    vi.mocked(getDepartures).mockResolvedValue([
      departure("inbound-1", 0, "Rockridge BART", 36000),
      departure("other-stop", 1, "Berkeley Marina", 36010, "12345"),
      departure("short-turn", 1, "Downtown Berkeley", 36020),
      departure("inbound-2", 0, "Rockridge BART", 36030),
      departure("unknown", null, "Berkeley Marina", 36040),
      departure("outbound-2", 1, "Berkeley Marina", 36050),
      departure("outbound-3", 1, "Berkeley Marina", 36060),
      departure("outbound-4", 1, "Berkeley Marina", 36070),
    ]);

    expect(await renderTripGroups()).toEqual([
      { heading: "To Rockridge BART", trips: ["inbound-1", "inbound-2"] },
      {
        heading: "To Berkeley Marina",
        trips: ["short-turn", "outbound-2", "outbound-3"],
      },
    ]);
  });

  it("still shows trips on routes with no direction IDs", async () => {
    vi.mocked(getRouteStops).mockResolvedValue([
      routeStop(null, "Berkeley Marina"),
    ]);
    vi.mocked(getDepartures).mockResolvedValue([
      departure("unspecified", null, "Berkeley Marina", 36000),
    ]);
    expect(await renderTripGroups()).toEqual([
      { heading: "To Berkeley Marina", trips: ["unspecified"] },
    ]);
  });
});
