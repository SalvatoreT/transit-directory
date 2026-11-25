import { describe, expect, it, vi } from "vitest";
import worker from "../worker";

vi.mock("vinext/server/app-router-entry", () => ({
  default: { fetch: vi.fn() },
}));
vi.mock("../src/Import511Workflow", () => ({
  Import511Workflow: class {},
}));

const sources = Array.from({ length: 101 }, (_, i) => ({
  feed_source_id: i + 1,
  source_name: `agency-${i + 1}`,
}));

async function dispatch(
  createBatch: ReturnType<typeof vi.fn>,
  scheduledTime: number,
) {
  const env = {
    gtfs_data: {
      prepare: () => ({ all: async () => ({ results: sources }) }),
    },
    IMPORT_511_WORKFLOW: { createBatch },
  } as unknown as Env;
  const waitUntil = vi.fn();
  await worker.scheduled(
    { scheduledTime, cron: "0 8 * * *" } as ScheduledController,
    env,
    { waitUntil } as unknown as ExecutionContext,
  );
  await waitUntil.mock.calls[0][0];
}

describe("daily 511 imports", () => {
  const scheduledTime = Date.parse("2026-03-01T08:00:00Z");
  it("uses stable per-source IDs for a scheduled day, in batches of at most 100", async () => {
    const createBatch = vi.fn().mockResolvedValue([]);
    await dispatch(createBatch, scheduledTime);
    await dispatch(createBatch, scheduledTime);
    await dispatch(createBatch, scheduledTime + 86_400_000);
    const batches = createBatch.mock.calls.map(([batch]) => batch);
    expect(batches.map((batch) => batch.length)).toEqual([
      100, 1, 100, 1, 100, 1,
    ]);
    expect(batches.slice(0, 2)).toEqual(batches.slice(2, 4));
    expect(batches[1]).toEqual([
      { id: "2026-03-01-daily-511-101", params: { id: "agency-101" } },
    ]);
    expect(batches[5][0].id).toBe("2026-03-02-daily-511-101");
  });

  it("attempts the remaining batches and reports a dispatch failure", async () => {
    const createBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue([]);
    await expect(dispatch(createBatch, scheduledTime)).rejects.toThrow(
      "Daily 511 import dispatch failed",
    );
    expect(createBatch).toHaveBeenCalledTimes(2);
  });
});
