import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import JSZip from "jszip";
import { DateTime } from "luxon";

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
  | "frequencies"
  | "areas"
  | "stop_areas"
  | "networks"
  | "route_networks"
  | "timeframes"
  | "rider_categories"
  | "fare_media"
  | "fare_products"
  | "fare_leg_rules"
  | "fare_leg_join_rules"
  | "fare_transfer_rules"
  | "location_groups"
  | "location_group_stops"
  | "booking_rules"
  | "translations"
  | "attributions"
  | "pathways"
  | "levels";

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
  areas: "areas.txt",
  stop_areas: "stop_areas.txt",
  networks: "networks.txt",
  route_networks: "route_networks.txt",
  timeframes: "timeframes.txt",
  rider_categories: "rider_categories.txt",
  fare_media: "fare_media.txt",
  fare_products: "fare_products.txt",
  fare_leg_rules: "fare_leg_rules.txt",
  fare_leg_join_rules: "fare_leg_join_rules.txt",
  fare_transfer_rules: "fare_transfer_rules.txt",
  location_groups: "location_groups.txt",
  location_group_stops: "location_group_stops.txt",
  booking_rules: "booking_rules.txt",
  translations: "translations.txt",
  attributions: "attributions.txt",
  pathways: "pathways.txt",
  levels: "levels.txt",
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

function parseGtfsDate(
  dateStr: string | undefined | null,
  timezone: string,
): number | null {
  if (!dateStr || dateStr.length !== 8) return null;
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6));
  const day = parseInt(dateStr.substring(6, 8));

  // Use noon to avoid DST edge cases when determining "day existence"
  const dt = DateTime.fromObject(
    { year, month, day, hour: 12 },
    { zone: timezone },
  );
  return dt.isValid ? Math.floor(dt.toSeconds()) : null;
}

function parseGtfsTime(timeStr: string | undefined | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(":");
  if (parts.length < 2) return null;
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const s = parts.length > 2 ? parseInt(parts[2]) : 0;
  return h * 3600 + m * 60 + s;
}

/**
 * Executes a large set of D1 prepared statements in smaller batches
 * to avoid RangeError (invalid string length) and other RPC limits.
 */
async function batchExecute(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 1000,
  concurrency = 5,
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (let i = 0; i < statements.length; i += chunkSize * concurrency) {
    const batchPromises = [];
    for (let j = 0; j < concurrency; j++) {
      const start = i + j * chunkSize;
      const chunk = statements.slice(start, start + chunkSize);
      if (chunk.length > 0) {
        batchPromises.push(db.batch(chunk));
      }
    }
    const batchResultsArray = await Promise.all(batchPromises);
    for (const batchResults of batchResultsArray) {
      results.push(...batchResults);
    }
  }
  return results;
}

export class Import511Workflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    console.log("Import511Workflow run started", event.payload);
    const { id: operatorId } = event.payload;
    const instanceId = event.instanceId;
    const prefix = `imports/${instanceId}`;

    const { hashHex } = await step.do(
      `[Import511] Download and unzip ${operatorId} to R2`,
      async () => {
        console.log("Starting fetch for", operatorId);
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
            const content = await file.async("uint8array");
            await this.env.gtfs_processing.put(
              `${prefix}/${fileName.toLowerCase()}`,
              content,
            );
          }
        }
        console.log("Finished unzip, hash:", hashHex);
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

    const { feedVersionId, feedInfo, isNewVersion, agencyTimezone } =
      await step.do(
        `[Import511] Initialize feed version for ${operatorId}`,
        async () => {
          console.log("Initializing feed version...");
          const agencyRows = await getFileRows("agency");
          const feedInfoRows = await getFileRows("feed_info");
          const feedInfo = feedInfoRows[0] || null;

          const sourceName = operatorId;
          const sourceDesc = agencyRows[0]?.agency_name ?? sourceName;
          const defaultLang =
            feedInfo?.feed_lang ?? agencyRows[0]?.agency_lang ?? null;

          const agencyTimezone = agencyRows[0]?.agency_timezone;
          if (!agencyTimezone) {
            throw new Error(`Agency timezone is missing for ${operatorId}`);
          }

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
          const feedStartDate = parseGtfsDate(
            feedInfo?.feed_start_date,
            agencyTimezone,
          );
          const feedEndDate = parseGtfsDate(
            feedInfo?.feed_end_date,
            agencyTimezone,
          );

          const res = await this.env.gtfs_data
            .prepare(
              `
            INSERT INTO feed_version (
              feed_source_id, version_label, date_added, feed_start_date, feed_end_date, is_active
            ) VALUES (?, ?, unixepoch(), ?, ?, 1)
            ON CONFLICT(feed_source_id, version_label) DO NOTHING
            RETURNING feed_version_id
          `,
            )
            .bind(feedSourceId, versionLabel, feedStartDate, feedEndDate)
            .run();

          let feedVersionId = res.results?.[0]?.feed_version_id as
            | number
            | undefined;
          let isNewVersion = false;

          if (feedVersionId) {
            isNewVersion = true;
          } else {
            // Version already exists! Get ID
            const existing = await this.env.gtfs_data
              .prepare(
                "SELECT feed_version_id FROM feed_version WHERE feed_source_id = ? AND version_label = ?",
              )
              .bind(feedSourceId, versionLabel)
              .first<{ feed_version_id: number }>();

            if (!existing)
              throw new Error("Failed to find existing feed_version_id");
            feedVersionId = existing.feed_version_id;

            // Ensure it is active
            await this.env.gtfs_data
              .prepare(
                "UPDATE feed_version SET is_active = 1 WHERE feed_version_id = ?",
              )
              .bind(feedVersionId)
              .run();
          }

          if (isNewVersion) {
            await this.env.gtfs_data.batch([
              // Clear realtime references first to avoid FK violations
              this.env.gtfs_data
                .prepare(
                  "UPDATE trip_updates SET trip_pk = NULL WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "UPDATE vehicle_positions SET trip_pk = NULL WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "UPDATE vehicle_positions SET route_pk = NULL WHERE route_pk IN (SELECT route_pk FROM routes WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "UPDATE service_alerts SET affected_trip_pk = NULL WHERE affected_trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "UPDATE service_alerts SET affected_route_pk = NULL WHERE affected_route_pk IN (SELECT route_pk FROM routes WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "UPDATE service_alerts SET affected_stop_pk = NULL WHERE affected_stop_pk IN (SELECT stop_pk FROM stops WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),

              // Delete static data
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM stop_times WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM frequencies WHERE trip_pk IN (SELECT trip_pk FROM trips WHERE feed_version_id = ?)",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM attributions WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM trips WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM transfers WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM pathways WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM stops WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM fare_attributes WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM fare_rules WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM routes WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM agency WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM feed_info WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM calendar WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM calendar_dates WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM shapes WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM levels WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM areas WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM stop_areas WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM networks WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM route_networks WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM timeframes WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM rider_categories WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM fare_media WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM fare_products WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM fare_leg_rules WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM fare_leg_join_rules WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM fare_transfer_rules WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM location_groups WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare(
                  "DELETE FROM location_group_stops WHERE feed_version_id = ?",
                )
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM booking_rules WHERE feed_version_id = ?")
                .bind(feedVersionId),
              this.env.gtfs_data
                .prepare("DELETE FROM translations WHERE feed_version_id = ?")
                .bind(feedVersionId),
            ]);
          }

          // De-activate other versions for this source
          await this.env.gtfs_data
            .prepare(
              "UPDATE feed_version SET is_active = 0 WHERE feed_source_id = ? AND feed_version_id != ?",
            )
            .bind(feedSourceId, feedVersionId)
            .run();

          return { feedVersionId, feedInfo, isNewVersion, agencyTimezone };
        },
      );

    if (isNewVersion && feedInfo) {
      await step.do(
        `[Import511] Import feed_info for ${operatorId}`,
        async () => {
          await this.env.gtfs_data
            .prepare(
              `
            INSERT INTO feed_info (
              feed_version_id, feed_publisher_name, feed_publisher_url, feed_lang,
              feed_version, feed_start_date, feed_end_date, feed_contact_email, feed_contact_url, default_lang
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(feed_version_id) DO UPDATE SET
              feed_publisher_name = excluded.feed_publisher_name,
              feed_publisher_url = excluded.feed_publisher_url,
              feed_lang = excluded.feed_lang,
              feed_version = excluded.feed_version,
              feed_start_date = excluded.feed_start_date,
              feed_end_date = excluded.feed_end_date,
              feed_contact_email = excluded.feed_contact_email,
              feed_contact_url = excluded.feed_contact_url,
              default_lang = excluded.default_lang
          `,
            )
            .bind(
              feedVersionId,
              nullIfEmpty(feedInfo.feed_publisher_name),
              nullIfEmpty(feedInfo.feed_publisher_url),
              nullIfEmpty(feedInfo.feed_lang),
              nullIfEmpty(feedInfo.feed_version),
              parseGtfsDate(feedInfo.feed_start_date, agencyTimezone),
              parseGtfsDate(feedInfo.feed_end_date, agencyTimezone),
              nullIfEmpty(feedInfo.feed_contact_email),
              nullIfEmpty(feedInfo.feed_contact_url),
              nullIfEmpty(feedInfo.default_lang),
            )
            .run();
        },
      );
    }

    if (isNewVersion) {
      await step.do(`[Import511] Import levels for ${operatorId}`, async () => {
        const levelsRows = await getFileRows("levels");
        const stmt = this.env.gtfs_data.prepare(
          `
          INSERT INTO levels (
            feed_version_id, level_id, level_index, level_name
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(feed_version_id, level_id) DO UPDATE SET
            level_index = excluded.level_index,
            level_name = excluded.level_name
        `,
        );

        const stmts = levelsRows.map((row) =>
          stmt.bind(
            feedVersionId,
            row.level_id,
            floatOrNull(row.level_index),
            nullIfEmpty(row.level_name),
          ),
        );
        if (stmts.length) {
          await batchExecute(this.env.gtfs_data, stmts);
        }
      });
    }

    let agencyMap: Record<string, number> = {};
    if (isNewVersion) {
      agencyMap = await step.do(
        `[Import511] Import agencies for ${operatorId}`,
        async () => {
          const agencyRows = await getFileRows("agency");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO agency (
            feed_version_id, agency_id, agency_name, agency_url, agency_timezone,
            agency_lang, agency_phone, agency_fare_url, agency_email, cemv_support
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_version_id, agency_id) DO UPDATE SET
            agency_name = excluded.agency_name,
            agency_url = excluded.agency_url,
            agency_timezone = excluded.agency_timezone,
            agency_lang = excluded.agency_lang,
            agency_phone = excluded.agency_phone,
            agency_fare_url = excluded.agency_fare_url,
            agency_email = excluded.agency_email,
            cemv_support = excluded.cemv_support
          RETURNING agency_pk
        `,
          );

          const stmts = agencyRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.agency_id),
              nullIfEmpty(row.agency_name),
              nullIfEmpty(row.agency_url),
              nullIfEmpty(row.agency_timezone),
              nullIfEmpty(row.agency_lang),
              nullIfEmpty(row.agency_phone),
              nullIfEmpty(row.agency_fare_url),
              nullIfEmpty(row.agency_email),
              intOrNull(row.cemv_support),
            ),
          );

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
    }

    let routeMap: Record<string, number> = {};
    if (isNewVersion) {
      routeMap = await step.do(
        `[Import511] Import routes for ${operatorId}`,
        async () => {
          const routeRows = await getFileRows("routes");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO routes (
            feed_version_id, route_id, agency_pk, route_short_name, route_long_name,
            route_desc, route_type, route_url, route_color, route_text_color,
            route_sort_order, continuous_pickup, continuous_drop_off, network_id, cemv_support
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            network_id = excluded.network_id,
            cemv_support = excluded.cemv_support
          RETURNING route_pk
        `,
          );

          const stmts = routeRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.route_id),
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
              intOrNull(row.cemv_support),
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
    }

    const stopsKey = `${prefix}/${GTFS_FILE_NAMES.stops.toLowerCase()}`;
    const stopsObj = await this.env.gtfs_processing.head(stopsKey);
    const stopsSize = stopsObj?.size ?? 0;
    const stopMap: Record<string, number> = {};
    const parentAssignments: Array<{ childPk: number; parentId: string }> = [];

    if (isNewVersion && stopsSize > 0) {
      let offset = 0;
      const CHUNK_SIZE = 512 * 1024; // 512KB
      let chunkIndex = 0;
      let headerLine = "";

      while (offset < stopsSize) {
        const result = await step.do(
          `[Import511] Import stops chunk ${chunkIndex} for ${operatorId}`,
          async () => {
            const isFirstChunk = offset === 0;
            const length = Math.min(CHUNK_SIZE, stopsSize - offset);

            let currentHeader = headerLine;
            if (!isFirstChunk && !currentHeader) {
              const headObj = await this.env.gtfs_processing.get(stopsKey, {
                range: { length: 4096 },
              });
              if (headObj) {
                const headText = await headObj.text();
                const firstLineEnd = headText.indexOf("\n");
                if (firstLineEnd !== -1) {
                  currentHeader = headText.substring(0, firstLineEnd).trim();
                }
              }
            }

            const chunkObj = await this.env.gtfs_processing.get(stopsKey, {
              range: { offset, length },
            });
            if (!chunkObj)
              return {
                processed: length,
                header: currentHeader,
                map: {},
                assignments: [],
              };

            let text = await chunkObj.text();
            let processedBytes = text.length;

            if (offset + length < stopsSize) {
              const lastNewline = text.lastIndexOf("\n");
              if (lastNewline !== -1) {
                text = text.substring(0, lastNewline);
                processedBytes = lastNewline + 1;
              }
            }

            if (isFirstChunk) {
              const firstNewline = text.indexOf("\n");
              if (firstNewline !== -1) {
                currentHeader = text.substring(0, firstNewline).trim();
              }
            }

            let csvContent = text;
            if (!isFirstChunk && currentHeader) {
              csvContent = currentHeader + "\n" + text;
            }

            const rows = parseCsv(csvContent);
            const stmt = this.env.gtfs_data.prepare(
              `
              INSERT INTO stops (
                feed_version_id, stop_id, stop_code, stop_name, tts_stop_name, stop_desc, stop_lat, stop_lon,
                zone_id, stop_url, location_type, parent_station, stop_timezone,
                wheelchair_boarding, level_id, platform_code, stop_access
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(feed_version_id, stop_id) DO UPDATE SET
                stop_code = excluded.stop_code,
                stop_name = excluded.stop_name,
                tts_stop_name = excluded.tts_stop_name,
                stop_desc = excluded.stop_desc,
                stop_lat = excluded.stop_lat,
                stop_lon = excluded.stop_lon,
                zone_id = excluded.zone_id,
                stop_url = excluded.stop_url,
                location_type = excluded.location_type,
                stop_timezone = excluded.stop_timezone,
                wheelchair_boarding = excluded.wheelchair_boarding,
                level_id = excluded.level_id,
                platform_code = excluded.platform_code,
                stop_access = excluded.stop_access
              RETURNING stop_pk
            `,
            );

            let stmts: D1PreparedStatement[] = [];
            let chunkRowsForMap: CsvRow[] = [];
            const BATCH_SIZE = 5000;
            const CONCURRENCY = 1;
            const TOTAL_CHUNK = BATCH_SIZE * CONCURRENCY;
            const localMap: Record<string, number> = {};
            const localAssignments: Array<{
              childPk: number;
              parentId: string;
            }> = [];

            const processLocalBatch = async () => {
              if (stmts.length === 0) return;
              const results = await batchExecute(
                this.env.gtfs_data,
                stmts,
                BATCH_SIZE,
                CONCURRENCY,
              );
              chunkRowsForMap.forEach((row, i) => {
                const pk =
                  (results[i].results?.[0] as any)?.stop_pk ||
                  results[i].meta.last_row_id;
                if (pk) {
                  localMap[row.stop_id] = pk;
                  if (row.parent_station) {
                    localAssignments.push({
                      childPk: pk,
                      parentId: row.parent_station,
                    });
                  }
                }
              });
              stmts = [];
              chunkRowsForMap = [];
            };

            for (const row of rows) {
              chunkRowsForMap.push(row);
              stmts.push(
                stmt.bind(
                  feedVersionId,
                  nullIfEmpty(row.stop_id),
                  nullIfEmpty(row.stop_code),
                  nullIfEmpty(row.stop_name),
                  nullIfEmpty(row.tts_stop_name),
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
                  intOrNull(row.stop_access),
                ),
              );

              if (stmts.length >= TOTAL_CHUNK) {
                await processLocalBatch();
              }
            }
            await processLocalBatch();

            return {
              processed: processedBytes,
              header: currentHeader,
              map: localMap,
              assignments: localAssignments,
            };
          },
        );

        offset += result.processed;
        headerLine = result.header || "";
        Object.assign(stopMap, result.map);
        parentAssignments.push(...result.assignments);
        chunkIndex++;
      }
    }

    if (isNewVersion && parentAssignments.length) {
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

    if (isNewVersion) {
      await step.do(
        `[Import511] Import calendar for ${operatorId}`,
        async () => {
          const calRows = await getFileRows("calendar");
          const stmt = this.env.gtfs_data.prepare(
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
          );

          const stmts = calRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.service_id),
              intOrNull(row.monday),
              intOrNull(row.tuesday),
              intOrNull(row.wednesday),
              intOrNull(row.thursday),
              intOrNull(row.friday),
              intOrNull(row.saturday),
              intOrNull(row.sunday),
              parseGtfsDate(row.start_date, agencyTimezone),
              parseGtfsDate(row.end_date, agencyTimezone),
            ),
          );
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import calendar_dates for ${operatorId}`,
        async () => {
          const calDateRows = await getFileRows("calendar_dates");
          const stmt = this.env.gtfs_data.prepare(
            `
        INSERT INTO calendar_dates (
          feed_version_id, service_id, date, exception_type
        ) VALUES (?, ?, ?, ?)
      `,
          );
          const stmts = calDateRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.service_id),
              parseGtfsDate(row.date, agencyTimezone),
              intOrNull(row.exception_type),
            ),
          );
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    const tripsKey = `${prefix}/${GTFS_FILE_NAMES.trips.toLowerCase()}`;
    const tripsObj = await this.env.gtfs_processing.head(tripsKey);
    const tripsSize = tripsObj?.size ?? 0;
    const tripMap: Record<string, number> = {};

    if (isNewVersion && tripsSize > 0) {
      let offset = 0;
      const CHUNK_SIZE = 512 * 1024; // 512KB
      let chunkIndex = 0;
      let headerLine = "";

      while (offset < tripsSize) {
        const result = await step.do(
          `[Import511] Import trips chunk ${chunkIndex} for ${operatorId}`,
          async () => {
            const isFirstChunk = offset === 0;
            const length = Math.min(CHUNK_SIZE, tripsSize - offset);

            let currentHeader = headerLine;
            if (!isFirstChunk && !currentHeader) {
              const headObj = await this.env.gtfs_processing.get(tripsKey, {
                range: { length: 4096 },
              });
              if (headObj) {
                const headText = await headObj.text();
                const firstLineEnd = headText.indexOf("\n");
                if (firstLineEnd !== -1) {
                  currentHeader = headText.substring(0, firstLineEnd).trim();
                }
              }
            }

            const chunkObj = await this.env.gtfs_processing.get(tripsKey, {
              range: { offset, length },
            });
            if (!chunkObj)
              return { processed: length, header: currentHeader, map: {} };

            let text = await chunkObj.text();
            let processedBytes = text.length;

            if (offset + length < tripsSize) {
              const lastNewline = text.lastIndexOf("\n");
              if (lastNewline !== -1) {
                text = text.substring(0, lastNewline);
                processedBytes = lastNewline + 1;
              }
            }

            if (isFirstChunk) {
              const firstNewline = text.indexOf("\n");
              if (firstNewline !== -1) {
                currentHeader = text.substring(0, firstNewline).trim();
              }
            }

            let csvContent = text;
            if (!isFirstChunk && currentHeader) {
              csvContent = currentHeader + "\n" + text;
            }

            const rows = parseCsv(csvContent);
            const stmt = this.env.gtfs_data.prepare(
              `
              INSERT INTO trips (
                feed_version_id, trip_id, route_pk, service_id, trip_headsign, trip_short_name,
                direction_id, block_id, shape_id, wheelchair_accessible, bikes_allowed, cars_allowed
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(feed_version_id, trip_id) DO UPDATE SET
                route_pk = excluded.route_pk,
                service_id = excluded.service_id,
                trip_headsign = excluded.trip_headsign,
                trip_short_name = excluded.trip_short_name,
                direction_id = excluded.direction_id,
                block_id = excluded.block_id,
                shape_id = excluded.shape_id,
                wheelchair_accessible = excluded.wheelchair_accessible,
                bikes_allowed = excluded.bikes_allowed,
                cars_allowed = excluded.cars_allowed
              RETURNING trip_pk
            `,
            );

            let stmts: D1PreparedStatement[] = [];
            let chunkRowsForMap: CsvRow[] = [];
            const BATCH_SIZE = 5000;
            const CONCURRENCY = 1;
            const TOTAL_CHUNK = BATCH_SIZE * CONCURRENCY;
            const localMap: Record<string, number> = {};

            const processLocalBatch = async () => {
              if (stmts.length === 0) return;
              const results = await batchExecute(
                this.env.gtfs_data,
                stmts,
                BATCH_SIZE,
                CONCURRENCY,
              );
              chunkRowsForMap.forEach((row, i) => {
                const pk =
                  (results[i].results?.[0] as any)?.trip_pk ||
                  results[i].meta.last_row_id;
                if (pk) localMap[row.trip_id] = pk;
              });
              stmts = [];
              chunkRowsForMap = [];
            };

            for (const row of rows) {
              const routePk = routeMap[row.route_id];
              if (!routePk) continue;
              chunkRowsForMap.push(row);
              stmts.push(
                stmt.bind(
                  feedVersionId,
                  nullIfEmpty(row.trip_id),
                  routePk,
                  nullIfEmpty(row.service_id),
                  nullIfEmpty(row.trip_headsign),
                  nullIfEmpty(row.trip_short_name),
                  intOrNull(row.direction_id),
                  nullIfEmpty(row.block_id),
                  nullIfEmpty(row.shape_id),
                  intOrNull(row.wheelchair_accessible),
                  intOrNull(row.bikes_allowed),
                  intOrNull(row.cars_allowed),
                ),
              );

              if (stmts.length >= TOTAL_CHUNK) {
                await processLocalBatch();
              }
            }
            await processLocalBatch();

            return {
              processed: processedBytes,
              header: currentHeader,
              map: localMap,
            };
          },
        );

        offset += result.processed;
        headerLine = result.header || "";
        Object.assign(tripMap, result.map);
        chunkIndex++;
      }
    }

    const stopTimesKey = `${prefix}/${GTFS_FILE_NAMES.stop_times.toLowerCase()}`;
    const stopTimesObj = await this.env.gtfs_processing.head(stopTimesKey);
    const stopTimesSize = stopTimesObj?.size ?? 0;

    if (isNewVersion && stopTimesSize > 0) {
      let offset = 0;
      const CHUNK_SIZE = 256 * 1024; // 256KB
      let chunkIndex = 0;
      let headerLine = "";

      while (offset < stopTimesSize) {
        const result = await step.do(
          `[Import511] Import stop_times chunk ${chunkIndex} for ${operatorId}`,
          async () => {
            const isFirstChunk = offset === 0;

            // Fetch chunk
            const length = Math.min(CHUNK_SIZE, stopTimesSize - offset);

            // We need the header if it's not the first chunk
            let currentHeader = headerLine;
            if (!isFirstChunk && !currentHeader) {
              const headObj = await this.env.gtfs_processing.get(stopTimesKey, {
                range: { length: 4096 },
              });
              if (headObj) {
                const headText = await headObj.text();
                const firstLineEnd = headText.indexOf("\n");
                if (firstLineEnd !== -1) {
                  currentHeader = headText.substring(0, firstLineEnd).trim();
                }
              }
            }

            const chunkObj = await this.env.gtfs_processing.get(stopTimesKey, {
              range: { offset, length },
            });

            if (!chunkObj) return { processed: length, header: currentHeader };

            let text = await chunkObj.text();
            let processedBytes = text.length;

            // If not the very last chunk, we must cut at the last newline
            if (offset + length < stopTimesSize) {
              const lastNewline = text.lastIndexOf("\n");
              if (lastNewline !== -1) {
                text = text.substring(0, lastNewline);
                processedBytes = lastNewline + 1; // +1 for the newline
              }
            }

            // If first chunk, extract header
            if (isFirstChunk) {
              const firstNewline = text.indexOf("\n");
              if (firstNewline !== -1) {
                currentHeader = text.substring(0, firstNewline).trim();
              }
            }

            // Prepare CSV
            let csvContent = text;
            if (!isFirstChunk && currentHeader) {
              csvContent = currentHeader + "\n" + text;
            }

            const rows = parseCsv(csvContent);

            const stmt = this.env.gtfs_data.prepare(
              `
              INSERT INTO stop_times (
                trip_pk, stop_pk, stop_sequence, arrival_time, departure_time,
                stop_headsign, pickup_type, drop_off_type, shape_dist_traveled, timepoint,
                location_group_id, location_id, start_pickup_drop_off_window, end_pickup_drop_off_window,
                continuous_pickup, continuous_drop_off, pickup_booking_rule_id, drop_off_booking_rule_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(trip_pk, stop_sequence) DO UPDATE SET
                stop_pk = excluded.stop_pk,
                arrival_time = excluded.arrival_time,
                departure_time = excluded.departure_time,
                stop_headsign = excluded.stop_headsign,
                pickup_type = excluded.pickup_type,
                drop_off_type = excluded.drop_off_type,
                shape_dist_traveled = excluded.shape_dist_traveled,
                timepoint = excluded.timepoint,
                location_group_id = excluded.location_group_id,
                location_id = excluded.location_id,
                start_pickup_drop_off_window = excluded.start_pickup_drop_off_window,
                end_pickup_drop_off_window = excluded.end_pickup_drop_off_window,
                continuous_pickup = excluded.continuous_pickup,
                continuous_drop_off = excluded.continuous_drop_off,
                pickup_booking_rule_id = excluded.pickup_booking_rule_id,
                drop_off_booking_rule_id = excluded.drop_off_booking_rule_id
            `,
            );

            let stmts: D1PreparedStatement[] = [];
            const BATCH_SIZE = 5000;
            const CONCURRENCY = 1;
            const TOTAL_CHUNK = BATCH_SIZE * CONCURRENCY;

            for (const row of rows) {
              const tripPk = tripMap[row.trip_id];
              const stopPk = stopMap[row.stop_id];
              if (!tripPk || !stopPk) continue;
              stmts.push(
                stmt.bind(
                  tripPk,
                  stopPk,
                  intOrNull(row.stop_sequence),
                  parseGtfsTime(row.arrival_time),
                  parseGtfsTime(row.departure_time),
                  nullIfEmpty(row.stop_headsign),
                  intOrNull(row.pickup_type),
                  intOrNull(row.drop_off_type),
                  floatOrNull(row.shape_dist_traveled),
                  intOrNull(row.timepoint),
                  nullIfEmpty(row.location_group_id),
                  nullIfEmpty(row.location_id),
                  parseGtfsTime(row.start_pickup_drop_off_window),
                  parseGtfsTime(row.end_pickup_drop_off_window),
                  intOrNull(row.continuous_pickup),
                  intOrNull(row.continuous_drop_off),
                  nullIfEmpty(row.pickup_booking_rule_id),
                  nullIfEmpty(row.drop_off_booking_rule_id),
                ),
              );

              if (stmts.length >= TOTAL_CHUNK) {
                await batchExecute(
                  this.env.gtfs_data,
                  stmts,
                  BATCH_SIZE,
                  CONCURRENCY,
                );
                stmts = [];
              }
            }
            if (stmts.length) {
              await batchExecute(
                this.env.gtfs_data,
                stmts,
                BATCH_SIZE,
                CONCURRENCY,
              );
            }

            return { processed: processedBytes, header: currentHeader };
          },
        );

        offset += result.processed;
        headerLine = result.header || "";
        chunkIndex++;
      }
    }

    const shapesKey = `${prefix}/${GTFS_FILE_NAMES.shapes.toLowerCase()}`;
    const shapesObj = await this.env.gtfs_processing.head(shapesKey);
    const shapesSize = shapesObj?.size ?? 0;

    if (isNewVersion && shapesSize > 0) {
      let offset = 0;
      const CHUNK_SIZE = 256 * 1024; // 256KB
      let chunkIndex = 0;
      let headerLine = "";

      while (offset < shapesSize) {
        const result = await step.do(
          `[Import511] Import shapes chunk ${chunkIndex} for ${operatorId}`,
          async () => {
            const isFirstChunk = offset === 0;
            const length = Math.min(CHUNK_SIZE, shapesSize - offset);

            let currentHeader = headerLine;
            if (!isFirstChunk && !currentHeader) {
              const headObj = await this.env.gtfs_processing.get(shapesKey, {
                range: { length: 4096 },
              });
              if (headObj) {
                const headText = await headObj.text();
                const firstLineEnd = headText.indexOf("\n");
                if (firstLineEnd !== -1) {
                  currentHeader = headText.substring(0, firstLineEnd).trim();
                }
              }
            }

            const chunkObj = await this.env.gtfs_processing.get(shapesKey, {
              range: { offset, length },
            });
            if (!chunkObj) return { processed: length, header: currentHeader };

            let text = await chunkObj.text();
            let processedBytes = text.length;

            if (offset + length < shapesSize) {
              const lastNewline = text.lastIndexOf("\n");
              if (lastNewline !== -1) {
                text = text.substring(0, lastNewline);
                processedBytes = lastNewline + 1;
              }
            }

            if (isFirstChunk) {
              const firstNewline = text.indexOf("\n");
              if (firstNewline !== -1) {
                currentHeader = text.substring(0, firstNewline).trim();
              }
            }

            let csvContent = text;
            if (!isFirstChunk && currentHeader) {
              csvContent = currentHeader + "\n" + text;
            }

            const rows = parseCsv(csvContent);
            const stmt = this.env.gtfs_data.prepare(
              `
              INSERT INTO shapes (
                feed_version_id, shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(feed_version_id, shape_id, shape_pt_sequence) DO UPDATE SET
                shape_pt_lat = excluded.shape_pt_lat,
                shape_pt_lon = excluded.shape_pt_lon,
                shape_dist_traveled = excluded.shape_dist_traveled
            `,
            );

            let stmts: D1PreparedStatement[] = [];
            const BATCH_SIZE = 5000;
            const CONCURRENCY = 1;
            const TOTAL_CHUNK = BATCH_SIZE * CONCURRENCY;

            for (const row of rows) {
              stmts.push(
                stmt.bind(
                  feedVersionId,
                  nullIfEmpty(row.shape_id),
                  floatOrNull(row.shape_pt_lat),
                  floatOrNull(row.shape_pt_lon),
                  intOrNull(row.shape_pt_sequence),
                  floatOrNull(row.shape_dist_traveled),
                ),
              );

              if (stmts.length >= TOTAL_CHUNK) {
                await batchExecute(
                  this.env.gtfs_data,
                  stmts,
                  BATCH_SIZE,
                  CONCURRENCY,
                );
                stmts = [];
              }
            }
            if (stmts.length) {
              await batchExecute(
                this.env.gtfs_data,
                stmts,
                BATCH_SIZE,
                CONCURRENCY,
              );
            }

            return { processed: processedBytes, header: currentHeader };
          },
        );

        offset += result.processed;
        headerLine = result.header || "";
        chunkIndex++;
      }
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import fare_attributes for ${operatorId}`,
        async () => {
          const fareAttrRows = await getFileRows("fare_attributes");
          const stmt = this.env.gtfs_data.prepare(
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
          );

          const stmts = fareAttrRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.fare_id),
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
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import fare_rules for ${operatorId}`,
        async () => {
          const fareRuleRows = await getFileRows("fare_rules");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO fare_rules (
            feed_version_id, fare_id, route_id, origin_id, destination_id, contains_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
          );
          const stmts = fareRuleRows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.fare_id),
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
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import transfers for ${operatorId}`,
        async () => {
          const transferRows = await getFileRows("transfers");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO transfers (
            feed_version_id, from_stop_pk, to_stop_pk, transfer_type, min_transfer_time,
            from_route_pk, to_route_pk, from_trip_pk, to_trip_pk
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          );

          const stmts: D1PreparedStatement[] = [];
          for (const row of transferRows) {
            const fromStopPk = stopMap[row.from_stop_id];
            const toStopPk = stopMap[row.to_stop_id];
            if (!fromStopPk || !toStopPk) continue;
            stmts.push(
              stmt.bind(
                feedVersionId,
                fromStopPk,
                toStopPk,
                intOrNull(row.transfer_type),
                intOrNull(row.min_transfer_time),
                routeMap[row.from_route_id || ""] ?? null,
                routeMap[row.to_route_id || ""] ?? null,
                tripMap[row.from_trip_id || ""] ?? null,
                tripMap[row.to_trip_id || ""] ?? null,
              ),
            );
          }
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import frequencies for ${operatorId}`,
        async () => {
          const freqRows = await getFileRows("frequencies");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO frequencies (
            trip_pk, start_time, end_time, headway_secs, exact_times
          ) VALUES (?, ?, ?, ?, ?)
        `,
          );

          const stmts: D1PreparedStatement[] = [];
          for (const row of freqRows) {
            const tripPk = tripMap[row.trip_id];
            if (!tripPk) continue;
            stmts.push(
              stmt.bind(
                tripPk,
                parseGtfsTime(row.start_time),
                parseGtfsTime(row.end_time),
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
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import attributions for ${operatorId}`,
        async () => {
          const attrRows = await getFileRows("attributions");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO attributions (
            feed_version_id, attribution_id, agency_pk, route_pk, trip_pk,
            organization_name, is_producer, is_operator, is_authority,
            attribution_url, attribution_email, attribution_phone
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          );

          const stmts: D1PreparedStatement[] = [];
          for (const row of attrRows) {
            stmts.push(
              stmt.bind(
                feedVersionId,
                nullIfEmpty(row.attribution_id),
                agencyMap[row.agency_id || ""] ?? null,
                routeMap[row.route_id || ""] ?? null,
                tripMap[row.trip_id || ""] ?? null,
                nullIfEmpty(row.organization_name),
                intOrNull(row.is_producer),
                intOrNull(row.is_operator),
                intOrNull(row.is_authority),
                nullIfEmpty(row.attribution_url),
                nullIfEmpty(row.attribution_email),
                nullIfEmpty(row.attribution_phone),
              ),
            );
          }
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import pathways for ${operatorId}`,
        async () => {
          const pathRows = await getFileRows("pathways");
          const stmt = this.env.gtfs_data.prepare(
            `
          INSERT INTO pathways (
            feed_version_id, pathway_id, from_stop_pk, to_stop_pk, pathway_mode,
            is_bidirectional, length, traversal_time, stair_count, max_slope,
            min_width, signposted_as, reversed_signposted_as
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_version_id, pathway_id) DO UPDATE SET
            from_stop_pk = excluded.from_stop_pk,
            to_stop_pk = excluded.to_stop_pk,
            pathway_mode = excluded.pathway_mode,
            is_bidirectional = excluded.is_bidirectional,
            length = excluded.length,
            traversal_time = excluded.traversal_time,
            stair_count = excluded.stair_count,
            max_slope = excluded.max_slope,
            min_width = excluded.min_width,
            signposted_as = excluded.signposted_as,
            reversed_signposted_as = excluded.reversed_signposted_as
        `,
          );

          const stmts: D1PreparedStatement[] = [];
          for (const row of pathRows) {
            const fromStopPk = stopMap[row.from_stop_id];
            const toStopPk = stopMap[row.to_stop_id];
            if (!fromStopPk || !toStopPk) continue;
            stmts.push(
              stmt.bind(
                feedVersionId,
                nullIfEmpty(row.pathway_id),
                fromStopPk,
                toStopPk,
                intOrNull(row.pathway_mode),
                intOrNull(row.is_bidirectional),
                floatOrNull(row.length),
                intOrNull(row.traversal_time),
                intOrNull(row.stair_count),
                floatOrNull(row.max_slope),
                floatOrNull(row.min_width),
                nullIfEmpty(row.signposted_as),
                nullIfEmpty(row.reversed_signposted_as),
              ),
            );
          }
          if (stmts.length) {
            await batchExecute(this.env.gtfs_data, stmts);
          }
        },
      );
    }

    if (isNewVersion) {
      await step.do(`[Import511] Import areas for ${operatorId}`, async () => {
        const rows = await getFileRows("areas");
        const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO areas (feed_version_id, area_id, area_name)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, area_id) DO UPDATE SET
            area_name = excluded.area_name
        `);
        const stmts = rows.map((row) =>
          stmt.bind(
            feedVersionId,
            nullIfEmpty(row.area_id),
            nullIfEmpty(row.area_name),
          ),
        );
        if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
      });

      await step.do(
        `[Import511] Import stop_areas for ${operatorId}`,
        async () => {
          const rows = await getFileRows("stop_areas");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO stop_areas (feed_version_id, area_id, stop_id)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, area_id, stop_id) DO NOTHING
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.area_id),
              nullIfEmpty(row.stop_id),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import networks for ${operatorId}`,
        async () => {
          const rows = await getFileRows("networks");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO networks (feed_version_id, network_id, network_name)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, network_id) DO UPDATE SET
            network_name = excluded.network_name
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.network_id),
              nullIfEmpty(row.network_name),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import route_networks for ${operatorId}`,
        async () => {
          const rows = await getFileRows("route_networks");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO route_networks (feed_version_id, network_id, route_id)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, network_id, route_id) DO NOTHING
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.network_id),
              nullIfEmpty(row.route_id),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import timeframes for ${operatorId}`,
        async () => {
          const rows = await getFileRows("timeframes");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO timeframes (feed_version_id, timeframe_group_id, start_time, end_time, service_id)
          VALUES (?, ?, ?, ?, ?)
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.timeframe_group_id || "",
              parseGtfsTime(row.start_time),
              parseGtfsTime(row.end_time),
              row.service_id || "",
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import rider_categories for ${operatorId}`,
        async () => {
          const rows = await getFileRows("rider_categories");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO rider_categories (feed_version_id, rider_category_id, rider_category_name, is_default_fare_category, eligibility_url)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(feed_version_id, rider_category_id) DO UPDATE SET
            rider_category_name = excluded.rider_category_name,
            is_default_fare_category = excluded.is_default_fare_category,
            eligibility_url = excluded.eligibility_url
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.rider_category_id || "",
              row.rider_category_name || "",
              intOrNull(row.is_default_fare_category) ?? 0,
              nullIfEmpty(row.eligibility_url),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import fare_media for ${operatorId}`,
        async () => {
          const rows = await getFileRows("fare_media");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO fare_media (feed_version_id, fare_media_id, fare_media_name, fare_media_type)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(feed_version_id, fare_media_id) DO UPDATE SET
            fare_media_name = excluded.fare_media_name,
            fare_media_type = excluded.fare_media_type
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.fare_media_id || "",
              nullIfEmpty(row.fare_media_name),
              intOrNull(row.fare_media_type) ?? 0,
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import fare_products for ${operatorId}`,
        async () => {
          const rows = await getFileRows("fare_products");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO fare_products (feed_version_id, fare_product_id, fare_product_name, rider_category_id, fare_media_id, amount, currency)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.fare_product_id || "",
              nullIfEmpty(row.fare_product_name),
              nullIfEmpty(row.rider_category_id),
              nullIfEmpty(row.fare_media_id),
              floatOrNull(row.amount) ?? 0.0,
              row.currency || "",
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import fare_leg_rules for ${operatorId}`,
        async () => {
          const rows = await getFileRows("fare_leg_rules");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO fare_leg_rules (feed_version_id, leg_group_id, network_id, from_area_id, to_area_id, from_timeframe_group_id, to_timeframe_group_id, fare_product_id, rule_priority)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.leg_group_id),
              nullIfEmpty(row.network_id),
              nullIfEmpty(row.from_area_id),
              nullIfEmpty(row.to_area_id),
              nullIfEmpty(row.from_timeframe_group_id),
              nullIfEmpty(row.to_timeframe_group_id),
              row.fare_product_id || "",
              intOrNull(row.rule_priority),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import fare_leg_join_rules for ${operatorId}`,
        async () => {
          const rows = await getFileRows("fare_leg_join_rules");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO fare_leg_join_rules (feed_version_id, from_network_id, to_network_id, from_stop_id, to_stop_id)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(feed_version_id, from_network_id, to_network_id, from_stop_id, to_stop_id) DO NOTHING
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.from_network_id || "",
              row.to_network_id || "",
              nullIfEmpty(row.from_stop_id),
              nullIfEmpty(row.to_stop_id),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import fare_transfer_rules for ${operatorId}`,
        async () => {
          const rows = await getFileRows("fare_transfer_rules");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO fare_transfer_rules (feed_version_id, from_leg_group_id, to_leg_group_id, transfer_count, duration_limit, duration_limit_type, fare_transfer_type, fare_product_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              nullIfEmpty(row.from_leg_group_id),
              nullIfEmpty(row.to_leg_group_id),
              intOrNull(row.transfer_count),
              intOrNull(row.duration_limit),
              intOrNull(row.duration_limit_type),
              intOrNull(row.fare_transfer_type) ?? 0,
              nullIfEmpty(row.fare_product_id),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );
    }

    if (isNewVersion) {
      await step.do(
        `[Import511] Import location_groups for ${operatorId}`,
        async () => {
          const rows = await getFileRows("location_groups");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO location_groups (feed_version_id, location_group_id, location_group_name)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, location_group_id) DO UPDATE SET
            location_group_name = excluded.location_group_name
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.location_group_id || "",
              nullIfEmpty(row.location_group_name),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import location_group_stops for ${operatorId}`,
        async () => {
          const rows = await getFileRows("location_group_stops");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO location_group_stops (feed_version_id, location_group_id, stop_id)
          VALUES (?, ?, ?)
          ON CONFLICT(feed_version_id, location_group_id, stop_id) DO NOTHING
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.location_group_id || "",
              row.stop_id || "",
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import booking_rules for ${operatorId}`,
        async () => {
          const rows = await getFileRows("booking_rules");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO booking_rules (
            feed_version_id, booking_rule_id, booking_type, prior_notice_duration_min,
            prior_notice_duration_max, prior_notice_last_day, prior_notice_last_time,
            prior_notice_start_day, prior_notice_start_time, prior_notice_service_id,
            message, pickup_message, drop_off_message, phone_number, info_url, booking_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_version_id, booking_rule_id) DO UPDATE SET
            booking_type = excluded.booking_type,
            prior_notice_duration_min = excluded.prior_notice_duration_min,
            prior_notice_duration_max = excluded.prior_notice_duration_max,
            prior_notice_last_day = excluded.prior_notice_last_day,
            prior_notice_last_time = excluded.prior_notice_last_time,
            prior_notice_start_day = excluded.prior_notice_start_day,
            prior_notice_start_time = excluded.prior_notice_start_time,
            prior_notice_service_id = excluded.prior_notice_service_id,
            message = excluded.message,
            pickup_message = excluded.pickup_message,
            drop_off_message = excluded.drop_off_message,
            phone_number = excluded.phone_number,
            info_url = excluded.info_url,
            booking_url = excluded.booking_url
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.booking_rule_id || "",
              intOrNull(row.booking_type) ?? 0,
              intOrNull(row.prior_notice_duration_min),
              intOrNull(row.prior_notice_duration_max),
              intOrNull(row.prior_notice_last_day),
              parseGtfsTime(row.prior_notice_last_time),
              intOrNull(row.prior_notice_start_day),
              parseGtfsTime(row.prior_notice_start_time),
              nullIfEmpty(row.prior_notice_service_id),
              nullIfEmpty(row.message),
              nullIfEmpty(row.pickup_message),
              nullIfEmpty(row.drop_off_message),
              nullIfEmpty(row.phone_number),
              nullIfEmpty(row.info_url),
              nullIfEmpty(row.booking_url),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );

      await step.do(
        `[Import511] Import translations for ${operatorId}`,
        async () => {
          const rows = await getFileRows("translations");
          const stmt = this.env.gtfs_data.prepare(`
          INSERT INTO translations (feed_version_id, table_name, field_name, language, translation, record_id, record_sub_id, field_value)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
          const stmts = rows.map((row) =>
            stmt.bind(
              feedVersionId,
              row.table_name || "",
              row.field_name || "",
              row.language || "",
              row.translation || "",
              nullIfEmpty(row.record_id),
              nullIfEmpty(row.record_sub_id),
              nullIfEmpty(row.field_value),
            ),
          );
          if (stmts.length) await batchExecute(this.env.gtfs_data, stmts);
        },
      );
    }

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
