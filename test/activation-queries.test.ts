import { describe, expect, it } from "vitest";
import {
  buildVersionServiceDayQuery,
  chooseActiveVersion,
  dayColumnFor,
} from "../src/activation-queries";

describe("dayColumnFor", () => {
  it("maps Luxon weekdays to calendar columns", () => {
    expect(dayColumnFor(1)).toBe("monday");
    expect(dayColumnFor(5)).toBe("friday");
    expect(dayColumnFor(6)).toBe("saturday");
    expect(dayColumnFor(7)).toBe("sunday");
  });
});

describe("buildVersionServiceDayQuery", () => {
  it("considers only fully imported versions, newest first", () => {
    const sql = buildVersionServiceDayQuery("sunday");
    expect(sql).toContain("fv.imported_at IS NOT NULL");
    expect(sql).toContain("fv.feed_source_id = ?1");
    expect(sql).toContain("ORDER BY fv.date_added DESC");
  });

  it("flags service from calendar and from added exceptions", () => {
    const sql = buildVersionServiceDayQuery("monday");
    expect(sql).toContain("c.monday = 1");
    expect(sql).toContain("c.start_date <= ?2");
    expect(sql).toContain("c.end_date >= ?2");
    expect(sql).toContain("cd.exception_type = 1");
  });

  it("does not count a service that today removes", () => {
    const sql = buildVersionServiceDayQuery("monday");
    expect(sql).toContain("cd.exception_type = 2");
    expect(sql).toContain("cd.service_id = c.service_id");
  });

  it("rejects day columns outside the calendar schema", () => {
    expect(() => buildVersionServiceDayQuery("monday = 1 OR 1=1 --")).toThrow(
      /Invalid calendar day column/,
    );
  });
});

describe("chooseActiveVersion", () => {
  it("skips a newer version whose service window has not opened", () => {
    // The BART regression: version 519 was downloaded on 2026-08-07 with a
    // first service day of 2026-08-10, and replaced 517, which did cover the
    // days in between.
    const chosen = chooseActiveVersion([
      { feed_version_id: 519, has_service_today: 0 },
      { feed_version_id: 517, has_service_today: 1 },
      { feed_version_id: 515, has_service_today: 1 },
    ]);
    expect(chosen).toBe(517);
  });

  it("skips an older version whose service has already expired", () => {
    // 511 re-serving an old ZIP must not resurrect an expired version.
    const chosen = chooseActiveVersion([
      { feed_version_id: 518, has_service_today: 1 },
      { feed_version_id: 510, has_service_today: 0 },
    ]);
    expect(chosen).toBe(518);
  });

  it("prefers the newest version when several cover today", () => {
    const chosen = chooseActiveVersion([
      { feed_version_id: 519, has_service_today: 1 },
      { feed_version_id: 517, has_service_today: 1 },
    ]);
    expect(chosen).toBe(519);
  });

  it("falls back to the newest version when none covers today", () => {
    const chosen = chooseActiveVersion([
      { feed_version_id: 519, has_service_today: 0 },
      { feed_version_id: 517, has_service_today: 0 },
    ]);
    expect(chosen).toBe(519);
  });

  it("leaves the live version alone when nothing is fully imported", () => {
    expect(chooseActiveVersion([])).toBeNull();
  });
});
