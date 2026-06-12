import { describe, expect, it } from "vitest";
import {
  REALTIME_STALENESS_SECONDS,
  TRIP_STOPS_LIMIT,
  buildDeparturesQuery,
  buildTripStopsQuery,
} from "../src/db-queries";

const baseFilter = {
  feed_version_id: 7,
  currentSeconds: 36000,
  endSeconds: 43200,
  todayNoon: 1750000000,
  todayColumn: "monday",
  nowEpochSeconds: 1750001234,
};

describe("buildDeparturesQuery", () => {
  it("filters realtime rows by staleness, bound before all filter params", () => {
    const { sql, params } = buildDeparturesQuery(baseFilter);
    expect(sql).toContain("tu.updated_time >= ?");
    expect(params[0]).toBe(1750001234 - REALTIME_STALENESS_SECONDS);
    expect(params[1]).toBe(7);
  });

  it("binds exactly one param per placeholder for every filter shape", () => {
    const filters = [
      baseFilter,
      { ...baseFilter, stopPks: [1, 2, 3] },
      { ...baseFilter, route_pk: 9 },
      { ...baseFilter, stopPks: [4], route_pk: 9, limit: 50 },
    ];
    for (const filter of filters) {
      const { sql, params } = buildDeparturesQuery(filter);
      const placeholders = (sql.match(/\?/g) || []).length;
      expect(placeholders).toBe(params.length);
    }
  });

  it("assembles stop and route conditions with params in order", () => {
    const { sql, params } = buildDeparturesQuery({
      ...baseFilter,
      stopPks: [11, 22],
      route_pk: 33,
    });
    expect(sql).toContain("s.stop_pk IN (?,?)");
    expect(sql).toContain("r.route_pk = ?");
    expect(params).toEqual([
      1750001234 - REALTIME_STALENESS_SECONDS,
      7,
      11,
      22,
      33,
      36000,
      43200,
      1750000000,
      1750000000,
      1750000000,
      1750000000,
    ]);
  });

  it("adds LIMIT only when requested", () => {
    expect(buildDeparturesQuery(baseFilter).sql).not.toContain("LIMIT");
    const limited = buildDeparturesQuery({ ...baseFilter, limit: 25 });
    expect(limited.sql).toContain("LIMIT ?");
    expect(limited.params[limited.params.length - 1]).toBe(25);
  });

  it("rejects day columns outside the calendar schema", () => {
    expect(() =>
      buildDeparturesQuery({
        ...baseFilter,
        todayColumn: "monday = 1 OR 1=1 --",
      }),
    ).toThrow(/Invalid calendar day column/);
  });
});

describe("buildTripStopsQuery", () => {
  it("filters realtime rows by staleness and caps the row count", () => {
    const { sql, params } = buildTripStopsQuery(42, 1750001234);
    expect(sql).toContain("tu.updated_time >= ?");
    expect(params).toEqual([1750001234 - REALTIME_STALENESS_SECONDS, 42]);
    expect(sql).toContain(`LIMIT ${TRIP_STOPS_LIMIT}`);
  });
});
