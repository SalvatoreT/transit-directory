import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import JSZip from "jszip";

interface Env {
  gtfs_data: D1Database;
  gtfs_processing: R2Bucket;
  API_KEY_511: string;
  IMPORT_511_WORKFLOW: any;
}

interface Params {
  id: string;
}

type CsvRow = Record<string, string>;

type FileKey =
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

const GTFS_FILE_NAMES: Record<FileKey, string> = {
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

function parseCsv(text: string): CsvRow[] {
  const lines = text
    .replace(new RegExp(String.fromCharCode(13), "g"), "")
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    return row;
  });
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

/**
 * Executes a large set of D1 prepared statements in smaller batches
 * to avoid RangeError (invalid string length) and other RPC limits.
 */
async function batchExecute(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 100,
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    const batchResults = await db.batch(chunk);
    results.push(...batchResults);
  }
  return results;
}

export class Import511Workflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    const { id: operatorId } = event.payload;
    const instanceId = event.instanceId;
    const prefix = `imports/${instanceId}`;

    const { hashHex } = await step.do(
      `[Import511] Download and unzip ${operatorId} to R2`,
      async () => {
        const response = await fetch(
          `https://api.511.org/transit/datafeeds?api_key=${this.env.API_KEY_511}&operator_id=${operatorId}`,
          { headers: { Accept: "application/zip" } },
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();

        // Calculate SHA-256 hash to detect same content
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const zip = await JSZip.loadAsync(arrayBuffer);

        for (const [name, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const fileName = name.split("/").pop();
          if (fileName) {
            const content = await file.async("string");
            await this.env.gtfs_processing.put(
              `${prefix}/${fileName.toLowerCase()}`,
              content,
            );
          }
        }
        return { hashHex };
      },
    );

    const getFileRows = async (key: FileKey): Promise<CsvRow[]> => {
      const fileName = GTFS_FILE_NAMES[key].toLowerCase();
      const object = await this.env.gtfs_processing.get(
        `${prefix}/${fileName}`,
      );
      if (!object) return [];
      const content = await object.text();
      return parseCsv(content);
    };

    const { feedVersionId, feedInfo, isNew } = await step.do(
      `[Import511] Initialize feed version for ${operatorId}`,
      async () => {
        const agencyRows = await getFileRows("agency");
        const feedInfoRows = await getFileRows("feed_info");
        const feedInfo = feedInfoRows[0] || null;

        const sourceName = operatorId;
        const sourceDesc = agencyRows[0]?.agency_name ?? sourceName;
        const defaultLang =
          feedInfo?.feed_lang ?? agencyRows[0]?.agency_lang ?? null;

        // Ensure feed source
        await this.env.gtfs_data
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

        const sourceRow = await this.env.gtfs_data
          .prepare(
            "SELECT feed_source_id FROM feed_source WHERE source_name = ?",
          )
          .bind(sourceName)
          .first<{ feed_source_id: number }>();

        if (!sourceRow) throw new Error("Failed to obtain feed_source_id");
        const feedSourceId = sourceRow.feed_source_id;

        // Try to insert the feed version based on content hash
        const versionLabel = `511-${operatorId}-${hashHex}`;
        const feedStartDate = nullIfEmpty(feedInfo?.feed_start_date);
        const feedEndDate = nullIfEmpty(feedInfo?.feed_end_date);

        const res = await this.env.gtfs_data
          .prepare(
            `
            INSERT INTO feed_version (
              feed_source_id, version_label, date_added, feed_start_date, feed_end_date, is_active
            ) VALUES (?, ?, DATE('now'), ?, ?, 1)
            ON CONFLICT(feed_source_id, version_label) DO NOTHING
            RETURNING feed_version_id
          `,
          )
          .bind(feedSourceId, versionLabel, feedStartDate, feedEndDate)
          .run();

        const feedVersionId = res.results?.[0]?.feed_version_id as
          | number
          | undefined;

        if (!feedVersionId) {
          // Version already exists! Skip rest of workflow.
          return { feedVersionId: null, isNew: false, feedInfo };
        }

        // De-activate other versions for this source
        await this.env.gtfs_data
          .prepare(
            "UPDATE feed_version SET is_active = 0 WHERE feed_source_id = ? AND feed_version_id != ?",
          )
          .bind(feedSourceId, feedVersionId)
          .run();

        return { feedVersionId, isNew: true, feedInfo };
      },
    );

    if (!isNew) {
      await step.do(
        `[Import511] Cleanup R2 (Skipped) for ${operatorId}`,
        async () => {
          const listed = await this.env.gtfs_processing.list({
            prefix: `${prefix}/`,
          });
          const keys = listed.objects.map((o) => o.key);
          if (keys.length) {
            await this.env.gtfs_processing.delete(keys);
          }
        },
      );
      return;
    }

    if (feedInfo) {
      await step.do(
        `[Import511] Import feed_info for ${operatorId}`,
        async () => {
          await this.env.gtfs_data
            .prepare(
              `
            INSERT INTO feed_info (
              feed_version_id, feed_publisher_name, feed_publisher_url, feed_lang,
              feed_version, feed_start_date, feed_end_date, feed_contact_email, feed_contact_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(feed_version_id) DO UPDATE SET
              feed_publisher_name = excluded.feed_publisher_name,
              feed_publisher_url = excluded.feed_publisher_url,
              feed_lang = excluded.feed_lang,
              feed_version = excluded.feed_version,
              feed_start_date = excluded.feed_start_date,
              feed_end_date = excluded.feed_end_date,
              feed_contact_email = excluded.feed_contact_email,
              feed_contact_url = excluded.feed_contact_url
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
        },
      );
    }

    const agencyMap = await step.do(
      `[Import511] Import agencies for ${operatorId}`,
      async () => {
        const agencyRows = await getFileRows("agency");
        const stmts: D1PreparedStatement[] = [];
        for (const row of agencyRows) {
          stmts.push(
            this.env.gtfs_data
              .prepare(
                `
                INSERT INTO agency (
                  feed_version_id, agency_id, agency_name, agency_url, agency_timezone,
                  agency_lang, agency_phone, agency_fare_url, agency_email
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(feed_version_id, agency_id) DO UPDATE SET
                  agency_name = excluded.agency_name,
                  agency_url = excluded.agency_url,
                  agency_timezone = excluded.agency_timezone,
                  agency_lang = excluded.agency_lang,
                  agency_phone = excluded.agency_phone,
                  agency_fare_url = excluded.agency_fare_url,
                  agency_email = excluded.agency_email
                RETURNING agency_pk
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
        const map: Record<string, number> = {};
        if (stmts.length) {
          const results = await batchExecute(this.env.gtfs_data, stmts);
          agencyRows.forEach((row, i) => {
            const pk =
              (results[i].results?.[0] as any)?.agency_pk ||
              results[i].meta.last_row_id;
            if (pk) map[row.agency_id || ""] = pk;
          });
        }
        return map;
      },
    );

    const routeMap = await step.do(
      `[Import511] Import routes for ${operatorId}`,
      async () => {
        const routeRows = await getFileRows("routes");
        const stmts = routeRows.map((row) =>
          this.env.gtfs_data
            .prepare(
              `
              INSERT INTO routes (
                feed_version_id, route_id, agency_pk, route_short_name, route_long_name,
                route_desc, route_type, route_url, route_color, route_text_color,
                route_sort_order, continuous_pickup, continuous_drop_off, network_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(feed_version_id, route_id) DO UPDATE SET
                agency_pk = excluded.agency_pk,
                route_short_name = excluded.route_short_name,
                route_long_name = excluded.route_long_name,
                route_desc = excluded.route_desc,
                route_type = excluded.route_type,
                route_url = excluded.route_url,
                route_color = excluded.route_color,
                route_text_color = excluded.route_text_color,
                route_sort_order = excluded.route_sort_order,
                continuous_pickup = excluded.continuous_pickup,
                continuous_drop_off = excluded.continuous_drop_off,
                network_id = excluded.network_id
              RETURNING route_pk
            `,
            )
            .bind(
              feedVersionId,
              row.route_id,
              agencyMap[row.agency_id || ""] ?? null,
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
        const map: Record<string, number> = {};
        if (stmts.length) {
          const results = await batchExecute(this.env.gtfs_data, stmts);
          routeRows.forEach((row, i) => {
            const pk =
              (results[i].results?.[0] as any)?.route_pk ||
              results[i].meta.last_row_id;
            if (pk) map[row.route_id] = pk;
          });
        }
        return map;
      },
    );

    const { stopMap, parentAssignments } = await step.do(
      `[Import511] Import stops for ${operatorId}`,
      async () => {
        const stopRows = await getFileRows("stops");
        const stmts = stopRows.map((row) =>
          this.env.gtfs_data
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
              RETURNING stop_pk
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

        const map: Record<string, number> = {};
        const assignments: Array<{ childPk: number; parentId: string }> = [];
        if (stmts.length) {
          const results = await batchExecute(this.env.gtfs_data, stmts);
          stopRows.forEach((row, i) => {
            const pk =
              (results[i].results?.[0] as any)?.stop_pk ||
              results[i].meta.last_row_id;
            if (pk) {
              map[row.stop_id] = pk;
              if (row.parent_station) {
                assignments.push({
                  childPk: pk,
                  parentId: row.parent_station,
                });
              }
            }
          });
        }
        return { stopMap: map, parentAssignments: assignments };
      },
    );

    if (parentAssignments.length) {
      await step.do(
        `[Import511] Update parent stations for ${operatorId}`,
        async () => {
          const stmts: D1PreparedStatement[] = [];
          for (const item of parentAssignments) {
            const parentPk = stopMap[item.parentId];
            if (parentPk) {
              stmts.push(
                this.env.gtfs_data
                  .prepare(
                    "UPDATE stops SET parent_station = ? WHERE stop_pk = ?",
                  )
                  .bind(parentPk, item.childPk),
              );
            }
          }
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    await step.do(`[Import511] Import calendar for ${operatorId}`, async () => {
      const calRows = await getFileRows("calendar");
      const stmts = calRows.map((row) =>
        this.env.gtfs_data
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
      if (stmts.length) {
        await batchExecute(this.env.gtfs_data, stmts);
      }
    });

    await step.do(
      `[Import511] Import calendar_dates for ${operatorId}`,
      async () => {
        const calDateRows = await getFileRows("calendar_dates");
        const stmts = calDateRows.map((row) =>
          this.env.gtfs_data
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
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    const tripMap = await step.do(
      `[Import511] Import trips for ${operatorId}`,
      async () => {
        const rawTripRows = await getFileRows("trips");
        const tripRows: CsvRow[] = [];
        const stmts: D1PreparedStatement[] = [];

        for (const row of rawTripRows) {
          const routePk = routeMap[row.route_id];
          if (!routePk) continue;
          tripRows.push(row);
          stmts.push(
            this.env.gtfs_data
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
                RETURNING trip_pk
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
        }
        const map: Record<string, number> = {};
        if (stmts.length) {
          const results = await batchExecute(this.env.gtfs_data, stmts);
          tripRows.forEach((row, i) => {
            const pk =
              (results[i].results?.[0] as any)?.trip_pk ||
              results[i].meta.last_row_id;
            if (pk) map[row.trip_id] = pk;
          });
        }
        return map;
      },
    );

    await step.do(
      `[Import511] Import stop_times for ${operatorId}`,
      async () => {
        const stopTimeRows = await getFileRows("stop_times");
        const stmts: D1PreparedStatement[] = [];
        for (const row of stopTimeRows) {
          const tripPk = tripMap[row.trip_id];
          const stopPk = stopMap[row.stop_id];
          if (!tripPk || !stopPk) continue;
          stmts.push(
            this.env.gtfs_data
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
        }
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    await step.do(`[Import511] Import shapes for ${operatorId}`, async () => {
      const shapeRows = await getFileRows("shapes");
      const stmts = shapeRows.map((row) =>
        this.env.gtfs_data
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
      if (stmts.length) {
        await batchExecute(this.env.gtfs_data, stmts);
      }
    });

    await step.do(
      `[Import511] Import fare_attributes for ${operatorId}`,
      async () => {
        const fareAttrRows = await getFileRows("fare_attributes");
        const stmts = fareAttrRows.map((row) =>
          this.env.gtfs_data
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
              agencyMap[row.agency_id || ""] ?? null,
              intOrNull(row.transfer_duration),
            ),
        );
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    await step.do(
      `[Import511] Import fare_rules for ${operatorId}`,
      async () => {
        const fareRuleRows = await getFileRows("fare_rules");
        const stmts = fareRuleRows.map((row) =>
          this.env.gtfs_data
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
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    await step.do(
      `[Import511] Import transfers for ${operatorId}`,
      async () => {
        const transferRows = await getFileRows("transfers");
        const stmts: D1PreparedStatement[] = [];
        for (const row of transferRows) {
          const fromStopPk = stopMap[row.from_stop_id];
          const toStopPk = stopMap[row.to_stop_id];
          if (!fromStopPk || !toStopPk) continue;
          stmts.push(
            this.env.gtfs_data
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
        }
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    await step.do(
      `[Import511] Import frequencies for ${operatorId}`,
      async () => {
        const freqRows = await getFileRows("frequencies");
        const stmts: D1PreparedStatement[] = [];
        for (const row of freqRows) {
          const tripPk = tripMap[row.trip_id];
          if (!tripPk) continue;
          stmts.push(
            this.env.gtfs_data
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
        }
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      },
    );

    await step.do(`[Import511] Cleanup R2 for ${operatorId}`, async () => {
      const listed = await this.env.gtfs_processing.list({
        prefix: `${prefix}/`,
      });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length) {
        await this.env.gtfs_processing.delete(keys);
      }
    });
  }
}
