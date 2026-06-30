import { describe, expect, it } from "vitest";
import {
  VERSION_RETENTION_SECONDS,
  buildCondemnedVersionsQuery,
  buildVersionCleanupStatements,
} from "../src/cleanup-queries";

describe("buildVersionCleanupStatements", () => {
  const statements = buildVersionCleanupStatements();
  const indexOf = (table: string, sqlPrefix = "DELETE") =>
    statements.findIndex(
      (s) => s.table === table && s.sql.startsWith(sqlPrefix),
    );

  it("deletes the largest referencing rows first", () => {
    expect(statements[0].table).toBe("stop_times");
  });

  it("deletes referencing rows before the rows they point at", () => {
    expect(indexOf("stop_times")).toBeLessThan(indexOf("trips"));
    expect(indexOf("frequencies")).toBeLessThan(indexOf("trips"));
    expect(indexOf("transfers")).toBeLessThan(indexOf("trips"));
    expect(indexOf("attributions")).toBeLessThan(indexOf("trips"));
    expect(indexOf("stop_times")).toBeLessThan(indexOf("stops"));
    expect(indexOf("transfers")).toBeLessThan(indexOf("stops"));
    expect(indexOf("pathways")).toBeLessThan(indexOf("stops"));
    expect(indexOf("trips")).toBeLessThan(indexOf("routes"));
    expect(indexOf("routes")).toBeLessThan(indexOf("agency"));
    expect(indexOf("fare_attributes")).toBeLessThan(indexOf("agency"));
    expect(indexOf("attributions")).toBeLessThan(indexOf("agency"));
  });

  it("nulls self-referencing parent stations before deleting stops", () => {
    const detach = statements.findIndex(
      (s) => s.table === "stops" && s.sql.includes("SET parent_station = NULL"),
    );
    expect(detach).toBeGreaterThan(0);
    expect(detach).toBeLessThan(indexOf("stops"));
  });

  it("removes the feed_version row last", () => {
    expect(statements[statements.length - 1].table).toBe("feed_version");
  });

  it("batches the tables that can hold millions of rows", () => {
    for (const table of ["stop_times", "trips", "stops", "shapes"]) {
      const statement = statements[indexOf(table)];
      expect(statement.batched, table).toBe(true);
      expect(statement.sql, table).toContain("LIMIT ?2");
    }
  });

  it("parameterizes every statement on the feed version", () => {
    for (const statement of statements) {
      expect(statement.sql, statement.table).toContain("?1");
    }
  });
});

describe("retention queries", () => {
  it("condemns only inactive versions past the retention window", () => {
    const sql = buildCondemnedVersionsQuery();
    expect(sql).toContain("is_active = 0");
    expect(sql).toContain(`${VERSION_RETENTION_SECONDS}`);
    // Versions that never got a deactivation stamp (crashed imports) age
    // out via date_added instead of lingering forever.
    expect(sql).toContain("COALESCE(deactivated_at, date_added)");
  });
});
