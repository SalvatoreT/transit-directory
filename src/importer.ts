type CsvRow = Record<string, string>;

export type GtfsFileProvider =
  | Partial<Record<FileKey, string>>
  | ((key: FileKey) => string | null | Promise<string | null>);

export interface GtfsFeedInput {
  sourceName: string;
  versionLabel: string;
  files: GtfsFileProvider;
}

export type FileKey =
  | "agency"
  | "routes"
  | "stops"
  | "calendar"
  | "calendar_dates"
  | "trips"
  | "stop_times"
  | "shapes"
  | "fare_attributes"
  | "fare_rules"
  | "transfers"
  | "feed_info"
  | "frequencies";

export const GTFS_FILE_NAMES: Record<FileKey, string> = {
  agency: "agency.txt",
  routes: "routes.txt",
  stops: "stops.txt",
  calendar: "calendar.txt",
  calendar_dates: "calendar_dates.txt",
  trips: "trips.txt",
  stop_times: "stop_times.txt",
  shapes: "shapes.txt",
  fare_attributes: "fare_attributes.txt",
  fare_rules: "fare_rules.txt",
  transfers: "transfers.txt",
  feed_info: "feed_info.txt",
  frequencies: "frequencies.txt",
};

interface Env {
  gtfs_data: D1Database;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Parses CSV text into rows, processing them one by one to save memory.
 */
function* parseCsv(text: string): Generator<CsvRow> {
  const lines = text
    .replace(new RegExp(String.fromCharCode(13), "g"), "")
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return;
  const headers = splitCsvLine(lines[0]);

  for (let i = 1; i < lines.length; i += 1) {
    const values = splitCsvLine(lines[i]);
    const row: CsvRow = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    yield row;
  }
}

function nullIfEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value === "" ? null : value;
}

function intOrNull(value: string | undefined): number | null {
  if (!value?.length) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function floatOrNull(value: string | undefined): number | null {
  if (!value?.length) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function resetDatabase(db: D1Database) {
  // Clear all rows in dependency order so re-imports start clean.
  await db.prepare("DELETE FROM vehicle_positions").run();
  await db.prepare("DELETE FROM trip_updates").run();
  await db.prepare("DELETE FROM service_alerts").run();
  await db.prepare("DELETE FROM stop_times").run();
  await db.prepare("DELETE FROM frequencies").run();
  await db.prepare("DELETE FROM transfers").run();
  await db.prepare("DELETE FROM fare_rules").run();
  await db.prepare("DELETE FROM fare_attributes").run();
  await db.prepare("DELETE FROM shapes").run();
  await db.prepare("DELETE FROM trips").run();
  await db.prepare("DELETE FROM calendar_dates").run();
  await db.prepare("DELETE FROM calendar").run();
  await db.prepare("DELETE FROM routes").run();
  await db.prepare("DELETE FROM stops").run();
  await db.prepare("DELETE FROM agency").run();
  await db.prepare("DELETE FROM feed_info").run();
  await db.prepare("DELETE FROM feed_version").run();
  await db.prepare("DELETE FROM feed_source").run();
  await db.prepare("DELETE FROM sqlite_sequence").run();
}

async function ensureFeedSource(
  db: D1Database,
  sourceName: string,
  sourceDesc: string | null,
  defaultLang: string | null,
): Promise<number> {
  await db
    .prepare(
      `
      INSERT INTO feed_source (source_name, source_desc, default_lang)
      VALUES (?, ?, ?)
      ON CONFLICT(source_name) DO UPDATE SET
        source_desc = excluded.source_desc,
        default_lang = excluded.default_lang
    `,
    )
    .bind(sourceName, sourceDesc, defaultLang)
    .run();

  const row = await db
    .prepare("SELECT feed_source_id FROM feed_source WHERE source_name = ?")
    .bind(sourceName)
    .first<{ feed_source_id: number }>();

  if (!row) {
    throw new Error("Failed to obtain feed_source_id");
  }

  return row.feed_source_id;
}

async function createFeedVersion(
  db: D1Database,
  feedSourceId: number,
  versionLabel: string,
  feedStartDate: string | null,
  feedEndDate: string | null,
): Promise<number> {
  const existing = await db
    .prepare(
      "SELECT feed_version_id FROM feed_version WHERE feed_source_id = ? AND version_label = ?",
    )
    .bind(feedSourceId, versionLabel)
    .first<{ feed_version_id: number } | null>();

  await db
    .prepare("UPDATE feed_version SET is_active = 0 WHERE feed_source_id = ?")
    .bind(feedSourceId)
    .run();

  if (existing) {
    await db
      .prepare(
        `
        UPDATE feed_version
        SET date_added = DATE('now'),
            feed_start_date = ?,
            feed_end_date = ?,
            is_active = 1
        WHERE feed_version_id = ?
      `,
      )
      .bind(feedStartDate, feedEndDate, existing.feed_version_id)
      .run();
    return existing.feed_version_id;
  }

  const res = await db
    .prepare(
      `
      INSERT INTO feed_version (
        feed_source_id, version_label, date_added, feed_start_date, feed_end_date, is_active
      ) VALUES (?, ?, DATE('now'), ?, ?, 1)
    `,
    )
    .bind(feedSourceId, versionLabel, feedStartDate, feedEndDate)
    .run();

  const id = res.meta.last_row_id;
  if (!id) throw new Error("Failed to create feed_version");
  return id;
}

async function clearFeedVersionData(db: D1Database, feedVersionId: number) {
  await db
    .prepare(
      "DELETE FROM stop_times WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
    )
    .bind(feedVersionId)
    .run();
  await db
    .prepare(
      "DELETE FROM frequencies WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
    )
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM transfers WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM fare_rules WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM fare_attributes WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM shapes WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM trips WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM calendar_dates WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM calendar WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM routes WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM stops WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM agency WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
  await db
    .prepare("DELETE FROM feed_info WHERE feed_version_id = ?")
    .bind(feedVersionId)
    .run();
}

async function getFileContent(
  files: GtfsFileProvider,
  key: FileKey,
): Promise<string | null> {
  if (typeof files === "function") {
    return await files(key);
  }
  return files[key] ?? null;
}

async function importFeed(feed: GtfsFeedInput, db: D1Database) {
  const getFileRows = async function* (key: FileKey) {
    const content = await getFileContent(feed.files, key);
    if (content) {
      yield* parseCsv(content);
    }
  };

  const agencyRows: CsvRow[] = [];
  for await (const row of getFileRows("agency")) {
    agencyRows.push(row);
  }

  const feedInfoRows: CsvRow[] = [];
  for await (const row of getFileRows("feed_info")) {
    feedInfoRows.push(row);
  }

  const feedInfo = feedInfoRows[0];
  const sourceDesc = agencyRows[0]?.agency_name ?? feed.sourceName;
  const defaultLang =
    feedInfo?.feed_lang ?? agencyRows[0]?.agency_lang ?? nullIfEmpty("");

  const feedSourceId = await ensureFeedSource(
    db,
    feed.sourceName,
    sourceDesc,
    defaultLang,
  );

  const feedVersionId = await createFeedVersion(
    db,
    feedSourceId,
    feed.versionLabel,
    nullIfEmpty(feedInfo?.feed_start_date),
    nullIfEmpty(feedInfo?.feed_end_date),
  );

  await clearFeedVersionData(db, feedVersionId);

  if (feedInfo) {
    await db
      .prepare(
        `
        INSERT OR REPLACE INTO feed_info (
          feed_version_id, feed_publisher_name, feed_publisher_url, feed_lang,
          feed_version, feed_start_date, feed_end_date, feed_contact_email, feed_contact_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        nullIfEmpty(feedInfo.feed_publisher_name),
        nullIfEmpty(feedInfo.feed_publisher_url),
        nullIfEmpty(feedInfo.feed_lang),
        nullIfEmpty(feedInfo.feed_version),
        nullIfEmpty(feedInfo.feed_start_date),
        nullIfEmpty(feedInfo.feed_end_date),
        nullIfEmpty(feedInfo.feed_contact_email),
        nullIfEmpty(feedInfo.feed_contact_url),
      )
      .run();
  }

  // Agencies
  const agencyMap = new Map<string | null, number>();
  for (const row of agencyRows) {
    const res = await db
      .prepare(
        `
        INSERT OR REPLACE INTO agency (
          feed_version_id, agency_id, agency_name, agency_url, agency_timezone,
          agency_lang, agency_phone, agency_fare_url, agency_email
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        nullIfEmpty(row.agency_id),
        nullIfEmpty(row.agency_name),
        nullIfEmpty(row.agency_url),
        nullIfEmpty(row.agency_timezone),
        nullIfEmpty(row.agency_lang),
        nullIfEmpty(row.agency_phone),
        nullIfEmpty(row.agency_fare_url),
        nullIfEmpty(row.agency_email),
      )
      .run();
    const pk = res.meta.last_row_id;
    agencyMap.set(nullIfEmpty(row.agency_id), pk ?? 0);
  }

  // Routes
  const routeMap = new Map<string, number>();
  for await (const row of getFileRows("routes")) {
    const res = await db
      .prepare(
        `
        INSERT OR REPLACE INTO routes (
          feed_version_id, route_id, agency_pk, route_short_name, route_long_name,
          route_desc, route_type, route_url, route_color, route_text_color,
          route_sort_order, continuous_pickup, continuous_drop_off, network_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.route_id,
        agencyMap.get(nullIfEmpty(row.agency_id) ?? null) ?? null,
        nullIfEmpty(row.route_short_name),
        nullIfEmpty(row.route_long_name),
        nullIfEmpty(row.route_desc),
        intOrNull(row.route_type),
        nullIfEmpty(row.route_url),
        nullIfEmpty(row.route_color),
        nullIfEmpty(row.route_text_color),
        intOrNull(row.route_sort_order),
        intOrNull(row.continuous_pickup),
        intOrNull(row.continuous_drop_off),
        nullIfEmpty(row.network_id),
      )
      .run();
    const pk = res.meta.last_row_id;
    if (pk) routeMap.set(row.route_id, pk);
  }

  // Stops
  const stopMap = new Map<string, number>();
  const parentAssignments: Array<{ childPk: number; parentId: string }> = [];

  for await (const row of getFileRows("stops")) {
    const res = await db
      .prepare(
        `
        INSERT INTO stops (
          feed_version_id, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon,
          zone_id, stop_url, location_type, parent_station, stop_timezone,
          wheelchair_boarding, level_id, platform_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.stop_id,
        nullIfEmpty(row.stop_code),
        nullIfEmpty(row.stop_name),
        nullIfEmpty(row.stop_desc),
        floatOrNull(row.stop_lat),
        floatOrNull(row.stop_lon),
        nullIfEmpty(row.zone_id),
        nullIfEmpty(row.stop_url),
        intOrNull(row.location_type),
        null,
        nullIfEmpty(row.stop_timezone),
        intOrNull(row.wheelchair_boarding),
        nullIfEmpty(row.level_id),
        nullIfEmpty(row.platform_code),
      )
      .run();
    const pk = res.meta.last_row_id;
    if (pk) {
      stopMap.set(row.stop_id, pk);
      if (row.parent_station) {
        parentAssignments.push({ childPk: pk, parentId: row.parent_station });
      }
    }
  }

  for (const item of parentAssignments) {
    const parentPk = stopMap.get(item.parentId);
    if (parentPk) {
      await db
        .prepare("UPDATE stops SET parent_station = ? WHERE stop_pk = ?")
        .bind(parentPk, item.childPk)
        .run();
    }
  }

  // Calendar
  for await (const row of getFileRows("calendar")) {
    await db
      .prepare(
        `
        INSERT INTO calendar (
          feed_version_id, service_id, monday, tuesday, wednesday, thursday,
          friday, saturday, sunday, start_date, end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.service_id,
        intOrNull(row.monday),
        intOrNull(row.tuesday),
        intOrNull(row.wednesday),
        intOrNull(row.thursday),
        intOrNull(row.friday),
        intOrNull(row.saturday),
        intOrNull(row.sunday),
        nullIfEmpty(row.start_date),
        nullIfEmpty(row.end_date),
      )
      .run();
  }

  // Calendar dates
  for await (const row of getFileRows("calendar_dates")) {
    await db
      .prepare(
        `
        INSERT INTO calendar_dates (
          feed_version_id, service_id, date, exception_type
        ) VALUES (?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.service_id,
        nullIfEmpty(row.date),
        intOrNull(row.exception_type),
      )
      .run();
  }

  // Trips
  const tripMap = new Map<string, number>();
  for await (const row of getFileRows("trips")) {
    const routePk = routeMap.get(row.route_id);
    if (!routePk) continue;
    const res = await db
      .prepare(
        `
        INSERT INTO trips (
          feed_version_id, trip_id, route_pk, service_id, trip_headsign, trip_short_name,
          direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.trip_id,
        routePk,
        row.service_id,
        nullIfEmpty(row.trip_headsign),
        nullIfEmpty(row.trip_short_name),
        intOrNull(row.direction_id),
        nullIfEmpty(row.block_id),
        nullIfEmpty(row.shape_id),
        intOrNull(row.wheelchair_accessible),
        intOrNull(row.bikes_allowed),
      )
      .run();
    const pk = res.meta.last_row_id;
    if (pk) tripMap.set(row.trip_id, pk);
  }

  // Stop times
  const stopTimeStatements: D1PreparedStatement[] = [];
  for await (const row of getFileRows("stop_times")) {
    const tripPk = tripMap.get(row.trip_id);
    const stopPk = stopMap.get(row.stop_id);
    if (!tripPk || !stopPk) continue;
    const stmt = db
      .prepare(
        `
        INSERT INTO stop_times (
          trip_pk, stop_pk, stop_sequence, arrival_time, departure_time,
          stop_headsign, pickup_type, drop_off_type, shape_dist_traveled, timepoint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        tripPk,
        stopPk,
        intOrNull(row.stop_sequence),
        nullIfEmpty(row.arrival_time),
        nullIfEmpty(row.departure_time),
        nullIfEmpty(row.stop_headsign),
        intOrNull(row.pickup_type),
        intOrNull(row.drop_off_type),
        floatOrNull(row.shape_dist_traveled),
        intOrNull(row.timepoint),
      );
    stopTimeStatements.push(stmt);
    if (stopTimeStatements.length >= 100) {
      await db.batch(stopTimeStatements);
      stopTimeStatements.length = 0;
    }
  }
  if (stopTimeStatements.length) {
    await db.batch(stopTimeStatements);
  }

  // Shapes
  const shapeStatements: D1PreparedStatement[] = [];
  for await (const row of getFileRows("shapes")) {
    const stmt = db
      .prepare(
        `
        INSERT INTO shapes (
          feed_version_id, shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.shape_id,
        floatOrNull(row.shape_pt_lat),
        floatOrNull(row.shape_pt_lon),
        intOrNull(row.shape_pt_sequence),
        floatOrNull(row.shape_dist_traveled),
      );
    shapeStatements.push(stmt);
    if (shapeStatements.length >= 100) {
      await db.batch(shapeStatements);
      shapeStatements.length = 0;
    }
  }
  if (shapeStatements.length) {
    await db.batch(shapeStatements);
  }

  // Fare attributes
  for await (const row of getFileRows("fare_attributes")) {
    await db
      .prepare(
        `
        INSERT INTO fare_attributes (
          feed_version_id, fare_id, price, currency_type, payment_method,
          transfers, agency_pk, transfer_duration
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.fare_id,
        floatOrNull(row.price),
        nullIfEmpty(row.currency_type),
        intOrNull(row.payment_method),
        intOrNull(row.transfers),
        agencyMap.get(nullIfEmpty(row.agency_id) ?? null) ?? null,
        intOrNull(row.transfer_duration),
      )
      .run();
  }

  // Fare rules
  for await (const row of getFileRows("fare_rules")) {
    await db
      .prepare(
        `
        INSERT INTO fare_rules (
          feed_version_id, fare_id, route_id, origin_id, destination_id, contains_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        row.fare_id,
        nullIfEmpty(row.route_id),
        nullIfEmpty(row.origin_id),
        nullIfEmpty(row.destination_id),
        nullIfEmpty(row.contains_id),
      )
      .run();
  }

  // Transfers
  for await (const row of getFileRows("transfers")) {
    const fromStopPk = stopMap.get(row.from_stop_id);
    const toStopPk = stopMap.get(row.to_stop_id);
    if (!fromStopPk || !toStopPk) continue;
    await db
      .prepare(
        `
        INSERT INTO transfers (
          feed_version_id, from_stop_pk, to_stop_pk, transfer_type, min_transfer_time
        ) VALUES (?, ?, ?, ?, ?)
      `,
      )
      .bind(
        feedVersionId,
        fromStopPk,
        toStopPk,
        intOrNull(row.transfer_type),
        intOrNull(row.min_transfer_time),
      )
      .run();
  }

  // Frequencies (optional)
  const freqStatements: D1PreparedStatement[] = [];
  for await (const row of getFileRows("frequencies")) {
    const tripPk = tripMap.get(row.trip_id);
    if (!tripPk) continue;
    freqStatements.push(
      db
        .prepare(
          `
          INSERT INTO frequencies (
            trip_pk, start_time, end_time, headway_secs, exact_times
          ) VALUES (?, ?, ?, ?, ?)
        `,
        )
        .bind(
          tripPk,
          nullIfEmpty(row.start_time),
          nullIfEmpty(row.end_time),
          intOrNull(row.headway_secs),
          intOrNull(row.exact_times),
        ),
    );
    if (freqStatements.length >= 100) {
      await db.batch(freqStatements);
      freqStatements.length = 0;
    }
  }
  if (freqStatements.length) {
    await db.batch(freqStatements);
  }
}

export interface ImportFeedOptions {
  clear?: boolean;
}

export async function importGtfsFeed(
  env: Env,
  feed: GtfsFeedInput,
  options?: ImportFeedOptions,
) {
  const clear = options?.clear ?? true;
  if (clear) {
    await resetDatabase(env.gtfs_data);
  }
  await importFeed(feed, env.gtfs_data);
}
