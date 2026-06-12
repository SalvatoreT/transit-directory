import { describe, expect, it } from "vitest";
import { computePacing } from "../src/realtime-utils";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe("computePacing", () => {
  it("falls back to the fixed 15s cadence when rate limit headers are missing", () => {
    expect(
      computePacing({ nowMs: 0, cutoffMs: HOUR_MS, rateLimitRemaining: null }),
    ).toEqual({ continueLoop: true, sleepSeconds: 15 });
  });

  it("spreads a small budget evenly across the remaining window", () => {
    // 59 minutes left, 59 usable requests (60 remaining minus 1 reserve)
    // -> one fetch per minute instead of burning out in the first quarter.
    const decision = computePacing({
      nowMs: MINUTE_MS,
      cutoffMs: HOUR_MS,
      rateLimitRemaining: 60,
    });
    expect(decision).toEqual({ continueLoop: true, sleepSeconds: 60 });
  });

  it("floors at the minimum cadence when the budget is ample", () => {
    const decision = computePacing({
      nowMs: 0,
      cutoffMs: HOUR_MS,
      rateLimitRemaining: 100_000,
    });
    expect(decision).toEqual({ continueLoop: true, sleepSeconds: 15 });
  });

  it("stops once only the reserve budget remains", () => {
    expect(
      computePacing({ nowMs: 0, cutoffMs: HOUR_MS, rateLimitRemaining: 1 })
        .continueLoop,
    ).toBe(false);
    expect(
      computePacing({ nowMs: 0, cutoffMs: HOUR_MS, rateLimitRemaining: 0 })
        .continueLoop,
    ).toBe(false);
  });

  it("stops at or past the cutoff", () => {
    expect(
      computePacing({
        nowMs: HOUR_MS,
        cutoffMs: HOUR_MS,
        rateLimitRemaining: 60,
      }).continueLoop,
    ).toBe(false);
    expect(
      computePacing({
        nowMs: HOUR_MS + MINUTE_MS,
        cutoffMs: HOUR_MS,
        rateLimitRemaining: null,
      }).continueLoop,
    ).toBe(false);
  });

  it("ends the loop instead of sleeping past the cutoff", () => {
    // 10 seconds left; even the minimum sleep would overlap the next
    // hourly workflow instance.
    const decision = computePacing({
      nowMs: HOUR_MS - 10_000,
      cutoffMs: HOUR_MS,
      rateLimitRemaining: null,
    });
    expect(decision.continueLoop).toBe(false);
  });

  it("never schedules a sleep shorter than the minimum cadence", () => {
    for (let remaining = 2; remaining < 200; remaining += 7) {
      for (let secondsLeft = 16; secondsLeft < 3600; secondsLeft += 311) {
        const decision = computePacing({
          nowMs: 0,
          cutoffMs: secondsLeft * 1000,
          rateLimitRemaining: remaining,
        });
        if (decision.continueLoop) {
          expect(decision.sleepSeconds).toBeGreaterThanOrEqual(15);
          expect(decision.sleepSeconds).toBeLessThan(secondsLeft);
        }
      }
    }
  });
});
