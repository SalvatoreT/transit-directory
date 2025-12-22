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
  const agencyStmts: D1PreparedStatement[] = [];
  for (const row of agencyRows) {
    agencyStmts.push(
      db
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
        ),
    );
  }
  if (agencyStmts.length) {
    const results = await db.batch(agencyStmts);
    agencyRows.forEach((row, i) => {
      const pk = results[i].meta.last_row_id;
      agencyMap.set(nullIfEmpty(row.agency_id), pk ?? 0);
    });
  }

  // Routes
  const routeMap = new Map<string, number>();
  const routeRows: CsvRow[] = [];
  const routeStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("routes")) {
    routeRows.push(row);
    routeStmts.push(
      db
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
        ),
    );
    if (routeStmts.length >= 100) {
      const results = await db.batch(routeStmts);
      const offset = routeRows.length - routeStmts.length;
      routeStmts.forEach((_, i) => {
        const pk = results[i].meta.last_row_id;
        if (pk) routeMap.set(routeRows[offset + i].route_id, pk);
      });
      routeStmts.length = 0;
    }
  }
  if (routeStmts.length) {
    const results = await db.batch(routeStmts);
    const offset = routeRows.length - routeStmts.length;
    routeStmts.forEach((_, i) => {
      const pk = results[i].meta.last_row_id;
      if (pk) routeMap.set(routeRows[offset + i].route_id, pk);
    });
  }

  // Stops
  const stopMap = new Map<string, number>();
  const stopRows: CsvRow[] = [];
  const stopStmts: D1PreparedStatement[] = [];
  const parentAssignments: Array<{ childPk: number; parentId: string }> = [];

  for await (const row of getFileRows("stops")) {
    stopRows.push(row);
    stopStmts.push(
      db
        .prepare(
          `
        INSERT INTO stops (
          feed_version_id, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon,
          zone_id, stop_url, location_type, parent_station, stop_timezone,
          wheelchair_boarding, level_id, platform_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_version_id, stop_id) DO UPDATE SET
          stop_code = excluded.stop_code,
          stop_name = excluded.stop_name,
          stop_desc = excluded.stop_desc,
          stop_lat = excluded.stop_lat,
          stop_lon = excluded.stop_lon,
          zone_id = excluded.zone_id,
          stop_url = excluded.stop_url,
          location_type = excluded.location_type,
          stop_timezone = excluded.stop_timezone,
          wheelchair_boarding = excluded.wheelchair_boarding,
          level_id = excluded.level_id,
          platform_code = excluded.platform_code
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
        ),
    );
    if (stopStmts.length >= 100) {
      const results = await db.batch(stopStmts);
      const offset = stopRows.length - stopStmts.length;
      stopStmts.forEach((_, i) => {
        const pk = results[i].meta.last_row_id;
        const r = stopRows[offset + i];
        if (pk) {
          stopMap.set(r.stop_id, pk);
          if (r.parent_station) {
            parentAssignments.push({ childPk: pk, parentId: r.parent_station });
          }
        }
      });
      stopStmts.length = 0;
    }
  }
  if (stopStmts.length) {
    const results = await db.batch(stopStmts);
    const offset = stopRows.length - stopStmts.length;
    stopStmts.forEach((_, i) => {
      const pk = results[i].meta.last_row_id;
      const r = stopRows[offset + i];
      if (pk) {
        stopMap.set(r.stop_id, pk);
        if (r.parent_station) {
          parentAssignments.push({ childPk: pk, parentId: r.parent_station });
        }
      }
    });
  }

  const parentStmts: D1PreparedStatement[] = [];
  for (const item of parentAssignments) {
    const parentPk = stopMap.get(item.parentId);
    if (parentPk) {
      parentStmts.push(
        db
          .prepare("UPDATE stops SET parent_station = ? WHERE stop_pk = ?")
          .bind(parentPk, item.childPk),
      );
    }
    if (parentStmts.length >= 100) {
      await db.batch(parentStmts);
      parentStmts.length = 0;
    }
  }
  if (parentStmts.length) {
    await db.batch(parentStmts);
  }

  // Calendar
  const calStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("calendar")) {
    calStmts.push(
      db
        .prepare(
          `
        INSERT INTO calendar (
          feed_version_id, service_id, monday, tuesday, wednesday, thursday,
          friday, saturday, sunday, start_date, end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_version_id, service_id) DO UPDATE SET
          monday = excluded.monday,
          tuesday = excluded.tuesday,
          wednesday = excluded.wednesday,
          thursday = excluded.thursday,
          friday = excluded.friday,
          saturday = excluded.saturday,
          sunday = excluded.sunday,
          start_date = excluded.start_date,
          end_date = excluded.end_date
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
        ),
    );
    if (calStmts.length >= 100) {
      await db.batch(calStmts);
      calStmts.length = 0;
    }
  }
  if (calStmts.length) {
    await db.batch(calStmts);
  }

  // Calendar dates
  const calDateStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("calendar_dates")) {
    calDateStmts.push(
      db
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
        ),
    );
    if (calDateStmts.length >= 100) {
      await db.batch(calDateStmts);
      calDateStmts.length = 0;
    }
  }
  if (calDateStmts.length) {
    await db.batch(calDateStmts);
  }

  // Trips
  const tripMap = new Map<string, number>();
  const tripRows: CsvRow[] = [];
  const tripStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("trips")) {
    const routePk = routeMap.get(row.route_id);
    if (!routePk) continue;
    tripRows.push(row);
    tripStmts.push(
      db
        .prepare(
          `
        INSERT INTO trips (
          feed_version_id, trip_id, route_pk, service_id, trip_headsign, trip_short_name,
          direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_version_id, trip_id) DO UPDATE SET
          route_pk = excluded.route_pk,
          service_id = excluded.service_id,
          trip_headsign = excluded.trip_headsign,
          trip_short_name = excluded.trip_short_name,
          direction_id = excluded.direction_id,
          block_id = excluded.block_id,
          shape_id = excluded.shape_id,
          wheelchair_accessible = excluded.wheelchair_accessible,
          bikes_allowed = excluded.bikes_allowed
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
        ),
    );
    if (tripStmts.length >= 100) {
      const results = await db.batch(tripStmts);
      const offset = tripRows.length - tripStmts.length;
      tripStmts.forEach((_, i) => {
        const pk = results[i].meta.last_row_id;
        if (pk) tripMap.set(tripRows[offset + i].trip_id, pk);
      });
      tripStmts.length = 0;
    }
  }
  if (tripStmts.length) {
    const results = await db.batch(tripStmts);
    const offset = tripRows.length - tripStmts.length;
    tripStmts.forEach((_, i) => {
      const pk = results[i].meta.last_row_id;
      if (pk) tripMap.set(tripRows[offset + i].trip_id, pk);
    });
  }

  // Stop times
  const stopTimeStatements: D1PreparedStatement[] = [];
  for await (const row of getFileRows("stop_times")) {
    const tripPk = tripMap.get(row.trip_id);
    const stopPk = stopMap.get(row.stop_id);
    if (!tripPk || !stopPk) continue;
    stopTimeStatements.push(
      db
        .prepare(
          `
        INSERT INTO stop_times (
          trip_pk, stop_pk, stop_sequence, arrival_time, departure_time,
          stop_headsign, pickup_type, drop_off_type, shape_dist_traveled, timepoint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trip_pk, stop_sequence) DO UPDATE SET
          stop_pk = excluded.stop_pk,
          arrival_time = excluded.arrival_time,
          departure_time = excluded.departure_time,
          stop_headsign = excluded.stop_headsign,
          pickup_type = excluded.pickup_type,
          drop_off_type = excluded.drop_off_type,
          shape_dist_traveled = excluded.shape_dist_traveled,
          timepoint = excluded.timepoint
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
        ),
    );
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
    shapeStatements.push(
      db
        .prepare(
          `
        INSERT INTO shapes (
          feed_version_id, shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_version_id, shape_id, shape_pt_sequence) DO UPDATE SET
          shape_pt_lat = excluded.shape_pt_lat,
          shape_pt_lon = excluded.shape_pt_lon,
          shape_dist_traveled = excluded.shape_dist_traveled
      `,
        )
        .bind(
          feedVersionId,
          row.shape_id,
          floatOrNull(row.shape_pt_lat),
          floatOrNull(row.shape_pt_lon),
          intOrNull(row.shape_pt_sequence),
          floatOrNull(row.shape_dist_traveled),
        ),
    );
    if (shapeStatements.length >= 100) {
      await db.batch(shapeStatements);
      shapeStatements.length = 0;
    }
  }
  if (shapeStatements.length) {
    await db.batch(shapeStatements);
  }

  // Fare attributes
  const fareAttrStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("fare_attributes")) {
    fareAttrStmts.push(
      db
        .prepare(
          `
        INSERT INTO fare_attributes (
          feed_version_id, fare_id, price, currency_type, payment_method,
          transfers, agency_pk, transfer_duration
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_version_id, fare_id) DO UPDATE SET
          price = excluded.price,
          currency_type = excluded.currency_type,
          payment_method = excluded.payment_method,
          transfers = excluded.transfers,
          agency_pk = excluded.agency_pk,
          transfer_duration = excluded.transfer_duration
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
        ),
    );
    if (fareAttrStmts.length >= 100) {
      await db.batch(fareAttrStmts);
      fareAttrStmts.length = 0;
    }
  }
  if (fareAttrStmts.length) {
    await db.batch(fareAttrStmts);
  }

  // Fare rules
  const fareRuleStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("fare_rules")) {
    fareRuleStmts.push(
      db
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
        ),
    );
    if (fareRuleStmts.length >= 100) {
      await db.batch(fareRuleStmts);
      fareRuleStmts.length = 0;
    }
  }
  if (fareRuleStmts.length) {
    await db.batch(fareRuleStmts);
  }

  // Transfers
  const transferStmts: D1PreparedStatement[] = [];
  for await (const row of getFileRows("transfers")) {
    const fromStopPk = stopMap.get(row.from_stop_id);
    const toStopPk = stopMap.get(row.to_stop_id);
    if (!fromStopPk || !toStopPk) continue;
    transferStmts.push(
      db
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
        ),
    );
    if (transferStmts.length >= 100) {
      await db.batch(transferStmts);
      transferStmts.length = 0;
    }
  }
  if (transferStmts.length) {
    await db.batch(transferStmts);
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

export async function importGtfsFeed(env: Env, feed: GtfsFeedInput) {
  await importFeed(feed, env.gtfs_data);
}
