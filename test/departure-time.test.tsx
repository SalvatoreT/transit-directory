import { DateTime } from "luxon";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DepartureTime from "../src/components/DepartureTime";
import StopHero from "../src/components/StopHero";
import { getServiceDay } from "../src/service-day";

const timezone = "America/Los_Angeles";
const serviceDay = getServiceDay(
  DateTime.fromISO("2026-03-07T18:30", { zone: timezone }),
);

describe("rider-facing departure times", () => {
  it("displays the estimated time when a delay pushes a trip past midnight", () => {
    const html = renderToStaticMarkup(
      <DepartureTime
        agencyId="AC"
        tripId="1"
        stopSequence={2}
        serviceDay={serviceDay}
        departureTime={23 * 3600 + 58 * 60}
        delay={300}
        status="SCHEDULED"
        timezone={timezone}
      />,
    );
    expect(html).toContain("12:03 AM (+1) (+5)");
    expect(html).toContain("/a/AC/t/1?stop=2");
  });

  it.each(["2026-03-08", "2026-11-01"])(
    "aligns the query and the displayed time on the DST transition %s",
    (date) => {
      const now = DateTime.fromISO(date + "T06:20:00", { zone: timezone });
      const day = getServiceDay(now);
      expect(day.todayNoon - day.start.toSeconds()).toBe(43200);
      expect(day.currentSeconds).toBe(6 * 3600 + 20 * 60);
      expect(day.formatTime(day.currentSeconds, timezone)).toBe("6:20 AM");
      expect(day.formatTime(day.currentSeconds, "America/Denver")).toBe(
        "7:20 AM",
      );
    },
  );

  it.each([
    ["CANCELED", "Canceled", "Trip canceled"],
    ["SKIPPED", "Stop skipped", "Stop skipped"],
  ])(
    "displays %s without predicting a departure or starting a countdown",
    (status, label, heroLabel) => {
      const html = renderToStaticMarkup(
        <DepartureTime
          agencyId="AC"
          tripId="1"
          stopSequence={2}
          serviceDay={serviceDay}
          departureTime={36000}
          delay={null}
          status={status}
          timezone={timezone}
        />,
      );
      expect(html).toContain(label);
      expect(html).not.toContain("10:00");
      const hero = renderToStaticMarkup(
        <StopHero
          routeColor="#fff"
          routeTextColor="#000"
          stopName="Market St"
          arrivalFormatted="10:00 AM"
          departureFormatted="10:00 AM"
          countdownTimestamp={0}
          status={status}
        />,
      );
      expect(hero).toContain(heroLabel);
      expect(hero).not.toContain("Countdown");
    },
  );
});
