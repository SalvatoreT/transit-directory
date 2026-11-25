import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import sitemap from "../app/sitemap";

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  env: { gtfs_data: { withSession: () => ({ prepare }) } },
}));

it("gets the active agencies and ordered routes in one query, including agencies with no routes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("../migrations/0001_initial_schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(`
      INSERT INTO feed_source(source_name) VALUES ('test');
      INSERT INTO feed_version(feed_source_id, is_active) VALUES (1, 1), (1, 0);
      INSERT INTO agency(feed_version_id, agency_id, agency_name, agency_url, agency_timezone)
        VALUES (1, 'BA', 'BART', '', 'America/Los_Angeles'), (1, 'empty', 'Empty', '', 'America/Los_Angeles'),
               (2, 'past', 'Retired', '', 'America/Los_Angeles');
      INSERT INTO routes(feed_version_id, agency_pk, route_id, route_type, route_sort_order, route_short_name)
        VALUES (1, 1, 'last', 1, 5, 'A'), (1, 1, 'second', 1, 1, 'B'), (1, 1, 'first', 1, 1, 'A'),
               (2, 3, 'retired', 1, 1, 'A');
    `);
    prepare.mockImplementation((sql: string) => ({
      all: async () => ({ results: db.prepare(sql).all() }),
    }));
    const entries = await sitemap();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => new URL(e.url).pathname)).toEqual([
      "/",
      "/a/BA",
      "/a/BA/r/first",
      "/a/BA/r/second",
      "/a/BA/r/last",
      "/a/empty",
    ]);
  } finally {
    db.close();
  }
});
