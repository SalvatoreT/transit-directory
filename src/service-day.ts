import { DateTime } from "luxon";

// GTFS measures stop times from 12 elapsed hours before agency-local noon,
// including on daylight saving transitions.
export function getServiceDay(now: DateTime) {
  const noon = now.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const start = noon.minus({ hours: 12 });
  const serviceDate = noon.toISODate()!;
  const clocks = new Map<
    string,
    {
      clock: Intl.DateTimeFormat;
      dayStart: number;
      dayEnd: number;
    }
  >();

  function formatTime(seconds: number, timezone: string): string {
    let local = clocks.get(timezone);
    if (!local) {
      const midnight = DateTime.fromISO(serviceDate, { zone: timezone });
      if (!midnight.isValid) return "Time unavailable";
      local = {
        clock: new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
        }),
        dayStart: midnight.toMillis(),
        dayEnd: midnight.plus({ days: 1 }).toMillis(),
      };
      clocks.set(timezone, local);
    }

    const timestamp = start.toMillis() + seconds * 1000;
    const clock = local.clock.format(timestamp);
    if (timestamp >= local.dayStart && timestamp < local.dayEnd) return clock;

    const date = DateTime.fromMillis(timestamp, {
      zone: timezone,
    }).toISODate()!;
    const days = (Date.parse(date) - Date.parse(serviceDate)) / 86_400_000;
    return `${clock} (${days > 0 ? "+" : ""}${days})`;
  }

  return {
    start,
    todayNoon: noon.toSeconds(),
    todayColumn: noon.setLocale("en-US").toFormat("cccc").toLowerCase(),
    currentSeconds: Math.floor((now.toMillis() - start.toMillis()) / 1000),
    formatTime,
  };
}

export type ServiceDay = ReturnType<typeof getServiceDay>;
