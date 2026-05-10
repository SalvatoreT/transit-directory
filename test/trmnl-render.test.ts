import { describe, it, expect } from "vitest";
import {
  renderFull,
  renderHalfHorizontal,
  renderHalfVertical,
  renderQuadrant,
  renderLayout,
  SCREEN_OG,
  SCREEN_X,
} from "../src/lib/trmnl/render";
import type { TrmnlStopData } from "../src/lib/trmnl/data";

function makeDepartures(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    routeName: `Route ${i + 1}`,
    headsign: `Destination ${i + 1}`,
    time: `${String(9 + i).padStart(2, "0")}:00`,
    delayText: i % 3 === 0 ? "On Time" : i % 3 === 1 ? "+5 min late" : "Sched.",
  }));
}

function makeData(
  departureCount: number,
  overrides: Partial<TrmnlStopData> = {},
): TrmnlStopData {
  const departures = makeDepartures(departureCount);
  return {
    stopName: "Test Station",
    stopId: "test-1",
    agencyName: "Test Agency",
    departures,
    departureCount: departures.length,
    lastUpdated: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function countTiles(html: string): number {
  return (html.match(/class="bt-tile"/g) || []).length;
}

function countEmpty(html: string): number {
  return (html.match(/class="bt-empty"/g) || []).length;
}

describe("TRMNL render - tile count per layout", () => {
  it("renderFull OG fills exactly 8 tiles when departures are plentiful", () => {
    const html = renderFull(makeData(30));
    expect(countTiles(html)).toBe(8);
    expect(countEmpty(html)).toBe(0);
  });

  it("renderFull X fills more tiles than OG", () => {
    const og = countTiles(renderFull(makeData(50)));
    const x = countTiles(renderFull(makeData(50), SCREEN_X));
    expect(x).toBeGreaterThan(og);
  });

  it("renderHalfHorizontal OG renders multiple tiles", () => {
    const html = renderHalfHorizontal(makeData(10));
    const tiles = countTiles(html);
    expect(tiles).toBeGreaterThanOrEqual(2);
    expect(tiles).toBeLessThanOrEqual(8);
  });

  it("renderHalfVertical OG renders single-column tiles", () => {
    const html = renderHalfVertical(makeData(10));
    const tiles = countTiles(html);
    expect(tiles).toBeGreaterThanOrEqual(3);
    expect(html).toContain("repeat(1, minmax(0, 1fr))");
  });

  it("renderQuadrant OG renders 3 compact tiles", () => {
    const html = renderQuadrant(makeData(10));
    expect(countTiles(html)).toBe(3);
    expect(html).toContain("repeat(1, minmax(0, 1fr))");
  });

  it("under-fills with dashed empty placeholders", () => {
    const html = renderFull(makeData(3));
    expect(countTiles(html)).toBe(3);
    expect(countEmpty(html)).toBe(5);
  });
});

describe("TRMNL render - header", () => {
  it("renders the stop name in the header", () => {
    const html = renderFull(makeData(1, { stopName: "Embarcadero Station" }));
    expect(html).toMatch(
      /class="bt-stop">EMBARCADERO STATION|Embarcadero Station/,
    );
    expect(html).toContain("Embarcadero Station");
  });

  it("renders the departure count in the header", () => {
    const html = renderFull(makeData(1, { departureCount: 42 }));
    expect(html).toMatch(/\/\/ 42 OUT/);
  });
});

describe("TRMNL render - departure content", () => {
  it("renders route name, headsign, and time for full layout", () => {
    const html = renderFull(makeData(1));
    expect(html).toContain("Route 1");
    expect(html).toContain("Destination 1");
    expect(html).toContain("09:00");
  });

  it("shows delay text when present and non-Sched", () => {
    const html = renderFull(makeData(2));
    // departure 0 has "On Time", departure 1 has "+5 min late"
    expect(html).toContain("On Time");
    expect(html).toContain("+5 min late");
  });

  it("hides Sched. delay text", () => {
    const html = renderFull(makeData(3));
    // departure 2 has "Sched." which should be suppressed
    expect(html).not.toContain("Sched.");
  });

  it("quadrant compact mode hides the headsign", () => {
    const html = renderQuadrant(makeData(3));
    expect(html).toContain("Route 1");
    expect(html).not.toContain("Destination 1");
  });

  it("half_horizontal compact mode hides the headsign", () => {
    const html = renderHalfHorizontal(makeData(2));
    expect(html).toContain("Route 1");
    expect(html).not.toContain("Destination 1");
  });
});

describe("TRMNL render - empty state", () => {
  it("renders 'No departures' overlay when departures is empty", () => {
    const html = renderFull(makeData(0));
    expect(html).toContain("bt-no-deps");
    expect(html).toMatch(/no departures/i);
    expect(countTiles(html)).toBe(0);
  });

  it("renders empty state on every layout", () => {
    for (const renderFn of [
      renderFull,
      renderHalfHorizontal,
      renderHalfVertical,
      renderQuadrant,
    ]) {
      const html = renderFn(makeData(0));
      expect(html).toContain("bt-no-deps");
    }
  });
});

describe("TRMNL render - viewport sizing", () => {
  it("renderFull body matches the requested screen", () => {
    const og = renderFull(makeData(1), SCREEN_OG);
    expect(og).toContain("width: 800px");
    expect(og).toContain("height: 480px");
    const x = renderFull(makeData(1), SCREEN_X);
    expect(x).toContain("width: 1872px");
    expect(x).toContain("height: 1404px");
  });

  it("renderHalfHorizontal body uses half the screen height", () => {
    const html = renderHalfHorizontal(makeData(1), SCREEN_OG);
    expect(html).toContain("width: 800px");
    expect(html).toContain("height: 240px");
  });

  it("renderHalfVertical body uses half the screen width", () => {
    const html = renderHalfVertical(makeData(1), SCREEN_OG);
    expect(html).toContain("width: 400px");
    expect(html).toContain("height: 480px");
  });

  it("renderQuadrant body uses quarter of the screen", () => {
    const html = renderQuadrant(makeData(1), SCREEN_OG);
    expect(html).toContain("width: 400px");
    expect(html).toContain("height: 240px");
  });
});

describe("TRMNL render - HTML escaping", () => {
  it("escapes HTML in stop name", () => {
    const html = renderFull(
      makeData(1, { stopName: "Test <script>alert('x')</script>" }),
    );
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML in route name and headsign", () => {
    const data = makeData(1);
    data.departures[0] = {
      routeName: "<b>Bold</b>",
      headsign: "& Co.",
      time: "10:00",
      delayText: "On Time",
    };
    const html = renderFull(data);
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    expect(html).toContain("&amp; Co.");
  });
});

describe("TRMNL render - renderLayout dispatch", () => {
  it("dispatches each known layout key", () => {
    const data = makeData(5);
    expect(renderLayout("full", data)).toBe(renderFull(data));
    expect(renderLayout("half_horizontal", data)).toBe(
      renderHalfHorizontal(data),
    );
    expect(renderLayout("half_vertical", data)).toBe(renderHalfVertical(data));
    expect(renderLayout("quadrant", data)).toBe(renderQuadrant(data));
  });

  it("falls back to renderFull on unknown layouts", () => {
    const data = makeData(5);
    expect(renderLayout("unknown", data)).toBe(renderFull(data));
  });
});
