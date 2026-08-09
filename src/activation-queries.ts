// Pure SQL builders and selection logic for deciding which imported feed
// version should be the live one. Kept free of "cloudflare:workers" imports
// so the selection rules are unit-testable with vitest.
//
// The newest version is not automatically the right one to serve. 511
// publishers routinely post a feed days before its service window opens: a
// BART feed downloaded on 2026-08-07 declared its first service day as
// 2026-08-10. Activating it on download stranded the site with a schedule
// that had no service for the current date, so every train stop showed no
// departures until the window opened. The same rule protects against the
// opposite case, where 511 re-serves an older feed whose service has already
// expired.
//
// Selection therefore prefers the newest imported version that actually runs
// service on the current service date, and only falls back to "newest" when
// no version covers today.

import { DAY_COLUMNS } from "./db-queries";

export interface VersionServiceDay {
  feed_version_id: number;
  // 1 when the version has at least one service running on the queried date.
  has_service_today: number;
}

/**
 * Maps a Luxon weekday (1 = Monday ... 7 = Sunday) to its calendar column.
 */
export function dayColumnFor(weekday: number): string {
  return DAY_COLUMNS[weekday % 7];
}

/**
 * Lists every fully imported version of a feed source, newest first, flagging
 * the ones that run service on the queried date.
 *
 * Binds ?1 = feed_source_id, ?2 = noon of the service date (the same
 * agency-timezone-noon convention the importer stores calendar dates in).
 * todayColumn is interpolated, so it is validated against DAY_COLUMNS.
 */
export function buildVersionServiceDayQuery(todayColumn: string): string {
  if (!DAY_COLUMNS.includes(todayColumn as (typeof DAY_COLUMNS)[number])) {
    throw new Error(`Invalid calendar day column: ${todayColumn}`);
  }

  // Mirrors the service-day predicate in buildDeparturesQuery: a regular
  // calendar service counts unless today removes it, and calendar_dates can
  // add a service on its own.
  return `
    SELECT
        fv.feed_version_id AS feed_version_id,
        CASE WHEN EXISTS (
            SELECT 1 FROM calendar c
            WHERE c.feed_version_id = fv.feed_version_id
              AND c.start_date <= ?2
              AND c.end_date >= ?2
              AND c.${todayColumn} = 1
              AND NOT EXISTS (
                  SELECT 1 FROM calendar_dates cd
                  WHERE cd.feed_version_id = c.feed_version_id
                    AND cd.service_id = c.service_id
                    AND cd.date = ?2
                    AND cd.exception_type = 2
              )
        ) OR EXISTS (
            SELECT 1 FROM calendar_dates cd
            WHERE cd.feed_version_id = fv.feed_version_id
              AND cd.date = ?2
              AND cd.exception_type = 1
        ) THEN 1 ELSE 0 END AS has_service_today
    FROM feed_version fv
    WHERE fv.feed_source_id = ?1
      AND fv.imported_at IS NOT NULL
    ORDER BY fv.date_added DESC, fv.feed_version_id DESC
  `;
}

/**
 * Picks the version to serve from buildVersionServiceDayQuery's rows, which
 * arrive newest first. Returns null when the source has no fully imported
 * version, in which case the caller leaves the current one alone.
 */
export function chooseActiveVersion(
  candidates: VersionServiceDay[],
): number | null {
  if (!candidates.length) return null;

  // No candidate covering today means the site shows no departures whichever
  // one is picked; the newest keeps agency, route, and stop pages current.
  const serving = candidates.find((c) => c.has_service_today === 1);
  return (serving ?? candidates[0]).feed_version_id;
}
