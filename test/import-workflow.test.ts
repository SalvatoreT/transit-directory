import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Import511Workflow } from "../src/Import511Workflow";
import { readCsvChunk } from "../src/import-csv";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      _ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

afterEach(() => vi.unstubAllGlobals());

function mockBucket() {
  const files = new Map<string, Uint8Array>();
  return {
    put: vi.fn((key: string, data: Uint8Array) => files.set(key, data)),
    get: vi.fn(
      (key: string, opts?: { range: { offset: number; length: number } }) => {
        const bytes = files.get(key);
        if (!bytes) return null;
        const range = opts?.range;
        return new Response(
          range
            ? bytes.slice(range.offset, range.offset + range.length)
            : bytes.slice(),
        );
      },
    ),
    head: vi.fn((key: string) => ({ size: files.get(key)?.length })),
    list: () => ({ objects: [...files.keys()].map((key) => ({ key })) }),
    delete: (keys: string[]) => keys.forEach((key) => files.delete(key)),
  };
}

function mockDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const statements: string[] = [];
  const prepare = (sql: string, params: SQLInputValue[] = []) => {
    const all = () => {
      statements.push(sql.trim());
      const results = db.prepare(sql).all(...params);
      return { results };
    };
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: () => all().results[0] ?? null,
      all,
      run: all,
    };
  };
  const binding = {
    prepare,
    batch: (stmts: ReturnType<typeof prepare>[]) => stmts.map((s) => s.run()),
  };
  return { db, binding, statements };
}

describe("static feed import", () => {
  it("stages and reads only consumed files, and skips recovery deletes for a fresh version", async () => {
    const zip = new JSZip();
    zip.file(
      "feed/AGENCY.txt",
      "agency_id,agency_name,agency_timezone,agency_url\nT,Transit,UTC,https://example.org\n",
    );
    zip.file("levels.txt", "level_id,level_index,level_name\nL,0,Street\n");
    zip.file("notes.pdf", "unused");
    const payload = await zip.generateAsync({ type: "arraybuffer" });
    vi.stubGlobal("fetch", async () => new Response(payload));

    const { db, binding, statements } = mockDatabase();
    const bucket = mockBucket();
    const names: string[] = [];
    const instance = new Import511Workflow({} as ExecutionContext, {
      gtfs_data: binding as unknown as D1Database,
      gtfs_processing: bucket as unknown as R2Bucket,
      API_KEY_511: "test",
      IMPORT_511_WORKFLOW: {},
    });
    const run = () =>
      instance.run(
        { instanceId: "run", payload: { id: "T" } } as Parameters<
          typeof instance.run
        >[0],
        {
          do: (name: string, ...args: unknown[]) => {
            names.push(name);
            return (args.at(-1) as () => Promise<unknown>)();
          },
        } as Parameters<typeof instance.run>[1],
      );
    try {
      await run();
      expect(bucket.put.mock.calls.map(([key]) => key)).toEqual([
        "imports/run/agency.txt",
        "imports/run/levels.txt",
      ]);
      expect(bucket.get.mock.calls.map(([key]) => key)).toEqual([
        "imports/run/agency.txt",
        "imports/run/levels.txt",
        "imports/run/agency.txt",
      ]);
      expect(bucket.head).not.toHaveBeenCalled();
      expect(
        names.some(
          (name) =>
            name.includes("Import shapes") || name.includes("Import areas"),
        ),
      ).toBe(false);
      expect(statements.some((sql) => sql.startsWith("DELETE"))).toBe(false);
      expect(
        db.prepare("SELECT is_active, imported_at FROM feed_version").get(),
      ).toMatchObject({ is_active: 1, imported_at: expect.any(Number) });

      const writes = () =>
        db.prepare("SELECT total_changes() AS writes").get()?.writes;
      const before = writes();
      await run();
      expect(writes()).toBe(before);
      expect(bucket.put).toHaveBeenCalledTimes(2);

      // A previous run can die after writing some rows. Its version still
      // needs recovery before the next run marks the import complete.
      db.exec("UPDATE feed_version SET is_active = 0, imported_at = NULL");
      await run();
      expect(
        statements.some((sql) => sql.startsWith("DELETE FROM stop_times")),
      ).toBe(true);
      expect(
        db.prepare("SELECT count(*) AS count FROM agency").get()?.count,
      ).toBe(1);
      expect(
        db.prepare("SELECT is_active FROM feed_version").get()?.is_active,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("CSV range reads", () => {
  it("advances in UTF-8 bytes and keeps long rows and the final unterminated line intact", async () => {
    const bucket = mockBucket();
    const lines = [
      "id,name",
      "1,Caf\u00e9",
      "2," + "\u8eca".repeat(15),
      "3,End",
    ];
    const bytes = new TextEncoder().encode(lines.join("\r\n"));
    bucket.put("stops.txt", bytes);
    let offset = 0;
    let header = "";
    const data: string[] = [];
    while (offset < bytes.length) {
      const part = await readCsvChunk(
        bucket as unknown as R2Bucket,
        "stops.txt",
        bytes.length,
        offset,
        12,
        header,
      );
      const [first, ...rows] = part.csvContent.trimEnd().split(/\r?\n/);
      expect(first).toBe(lines[0]);
      data.push(...rows);
      header = part.currentHeader;
      offset += part.processedBytes;
    }
    expect(offset).toBe(bytes.length);
    expect(data).toEqual(lines.slice(1));
  });

  it("fails the step when a staged object disappears", async () => {
    await expect(
      readCsvChunk(
        mockBucket() as unknown as R2Bucket,
        "stops.txt",
        10,
        0,
        10,
        "",
      ),
    ).rejects.toThrow("Missing staged GTFS file");
  });
});
