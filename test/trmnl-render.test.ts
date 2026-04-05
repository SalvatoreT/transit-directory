import { describe, it, expect } from "vitest";
import {
  renderFull,
  renderHalfHorizontal,
  renderHalfVertical,
  renderQuadrant,
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

function makeData(departureCount: number): TrmnlStopData {
  const departures = makeDepartures(departureCount);
  return {
    stopName: "Test Station",
    stopId: "test-1",
    agencyName: "Test Agency",
    departures,
    departureCount: departures.length,
  };
}

describe("TRMNL render - grid column layout", () => {
  it("renderFull uses grid--cols-2", () => {
    const html = renderFull(makeData(5));
    expect(html).toContain("grid--cols-2");
  });

  it("renderHalfHorizontal uses grid--cols-2", () => {
    const html = renderHalfHorizontal(makeData(3));
    expect(html).toContain("grid--cols-2");
  });

  it("renderHalfVertical uses grid--cols-1", () => {
    const html = renderHalfVertical(makeData(5));
    expect(html).toContain("grid--cols-1");
    expect(html).not.toContain("grid--cols-2");
  });

  it("renderQuadrant uses grid--cols-1", () => {
    const html = renderQuadrant(makeData(3));
    expect(html).toContain("grid--cols-1");
    expect(html).not.toContain("grid--cols-2");
  });
});

describe("TRMNL render - departure count limits", () => {
  it("renderFull shows at most 8 departures", () => {
    const html = renderFull(makeData(12));
    const matches = html.match(/class="item item--emphasis-/g);
    expect(matches).toHaveLength(8);
  });

  it("renderHalfHorizontal shows at most 3 departures", () => {
    const html = renderHalfHorizontal(makeData(10));
    const matches = html.match(/class="item item--emphasis-/g);
    expect(matches).toHaveLength(3);
  });

  it("renderHalfVertical shows at most 5 departures", () => {
    const html = renderHalfVertical(makeData(10));
    const matches = html.match(/class="item item--emphasis-/g);
    expect(matches).toHaveLength(5);
  });

  it("renderQuadrant shows 1 featured + at most 2 compact", () => {
    const html = renderQuadrant(makeData(10));
    const matches = html.match(/class="item item--emphasis-/g);
    expect(matches).toHaveLength(3);
  });
});

describe("TRMNL render - emphasis levels", () => {
  it("renderFull uses emphasis-3 for departure items", () => {
    const html = renderFull(makeData(1));
    expect(html).toContain("item--emphasis-3");
  });

  it("renderHalfHorizontal uses emphasis-2 for compact items", () => {
    const html = renderHalfHorizontal(makeData(1));
    expect(html).toContain("item--emphasis-2");
  });

  it("renderQuadrant uses emphasis-3 for featured and emphasis-2 for compact", () => {
    const html = renderQuadrant(makeData(3));
    expect(html).toContain("item--emphasis-3");
    expect(html).toContain("item--emphasis-2");
  });
});

describe("TRMNL render - time in meta area", () => {
  it("time appears in .meta div with monospace font", () => {
    const html = renderFull(makeData(1));
    expect(html).toMatch(/class="meta"[^>]*>/);
    expect(html).toMatch(/style="font-family: monospace;[^"]*"[^>]*>09:00</);
  });

  it("time does not appear in .content .title span", () => {
    const html = renderFull(makeData(1));
    const contentTitles = html.match(
      /<div class="content">[\s\S]*?<span class="title">([^<]*)/g,
    );
    expect(contentTitles).not.toBeNull();
    for (const match of contentTitles!) {
      expect(match).not.toContain("09:00");
    }
  });

  it("delay labels use large label class", () => {
    const html = renderFull(makeData(2));
    expect(html).toContain('class="label label--success"');
    expect(html).not.toContain("label--small");
  });
});
