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
    time: `${9 + i}:00 AM`,
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

describe("TRMNL render - single-column layout", () => {
  it("renderFull uses grid--cols-1", () => {
    const html = renderFull(makeData(5));
    expect(html).toContain("grid--cols-1");
    expect(html).not.toContain("grid--cols-2");
  });

  it("renderHalfHorizontal uses grid--cols-1", () => {
    const html = renderHalfHorizontal(makeData(3));
    expect(html).toContain("grid--cols-1");
    expect(html).not.toContain("grid--cols-2");
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
  it("renderFull shows at most 5 departures", () => {
    const html = renderFull(makeData(10));
    const matches = html.match(/class="item item--emphasis-/g);
    expect(matches).toHaveLength(5);
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
    expect(html).toContain("item--emphasis-3");
  });
});

describe("TRMNL render - large CSS classes", () => {
  it("departure items use large title class (not title--small)", () => {
    const html = renderFull(makeData(1));
    expect(html).not.toContain("title--small");
    expect(html).toMatch(/<span class="title">/);
  });

  it("departure items use large label class (not label--small)", () => {
    const html = renderFull(makeData(1));
    expect(html).not.toContain("label--small");
  });

  it("compact departure items use large title class", () => {
    const html = renderHalfHorizontal(makeData(1));
    expect(html).not.toContain("title--small");
    expect(html).toMatch(/<span class="title">/);
  });

  it("compact departure items use large label class", () => {
    const html = renderHalfHorizontal(makeData(1));
    expect(html).not.toContain("label--small");
  });

  it("delay labels use large label class", () => {
    const html = renderFull(makeData(2));
    expect(html).toContain('class="label label--success"');
    expect(html).not.toContain("label--small");
  });
});
