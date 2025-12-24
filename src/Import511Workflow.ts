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

async function* streamCsv(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CsvRow> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let leftover = "";
  let headers: string[] | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = leftover + decoder.decode(value, { stream: true });
    const lines = chunk.split(
      new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10)),
    );
    leftover = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const values = splitCsvLine(line);
      if (!headers) {
        headers = values;
      } else {
        const row: CsvRow = {};
        headers.forEach((h, idx) => {
          row[h] = values[idx] ?? "";
        });
        yield row;
      }
    }
  }

  if (leftover.trim()) {
    const values = splitCsvLine(leftover);
    if (headers) {
      const row: CsvRow = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] ?? "";
      });
      yield row;
    }
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
            const content = await file.async("uint8array");
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

    const getFileStream = async (
      key: FileKey,
    ): Promise<AsyncGenerator<CsvRow>> => {
      const fileName = GTFS_FILE_NAMES[key].toLowerCase();
      const object = await this.env.gtfs_processing.get(
        `${prefix}/${fileName}`,
      );
      if (!object || !object.body) {
        return (async function* () {})();
      }
      return streamCsv(object.body);
    };

    const { feedVersionId, feedInfo } = await step.do(
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

        let feedVersionId = res.results?.[0]?.feed_version_id as
          | number
          | undefined;

        if (!feedVersionId) {
          // Version already exists! Get ID and delete existing data for a clean re-import
          const existing = await this.env.gtfs_data
            .prepare(
              "SELECT feed_version_id FROM feed_version WHERE feed_source_id = ? AND version_label = ?",
            )
            .bind(feedSourceId, versionLabel)
            .first<{ feed_version_id: number }>();

          if (!existing)
            throw new Error("Failed to find existing feed_version_id");
          feedVersionId = existing.feed_version_id;

          await this.env.gtfs_data.batch([
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
              .prepare("DELETE FROM fare_attributes WHERE feed_version_id = ?")
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
          ]);
        }

        // De-activate other versions for this source
        await this.env.gtfs_data
          .prepare(
            "UPDATE feed_version SET is_active = 0 WHERE feed_source_id = ? AND feed_version_id != ?",
          )
          .bind(feedSourceId, feedVersionId)
          .run();

        return { feedVersionId, feedInfo };
      },
    );

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
        const stmt = this.env.gtfs_data.prepare(
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

    const routeMap = await step.do(
      `[Import511] Import routes for ${operatorId}`,
      async () => {
        const routeRows = await getFileRows("routes");
        const stmt = this.env.gtfs_data.prepare(
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
        );

        const stmts = routeRows.map((row) =>
          stmt.bind(
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

    const stopsKey = `${prefix}/${GTFS_FILE_NAMES.stops.toLowerCase()}`;
    const stopsObj = await this.env.gtfs_processing.head(stopsKey);
    const stopsSize = stopsObj?.size ?? 0;
    const stopMap: Record<string, number> = {};
    const parentAssignments: Array<{ childPk: number; parentId: string }> = [];

    if (stopsSize > 0) {
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
            if (!chunkObj) return { processed: length, header: currentHeader, map: {}, assignments: [] };

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
            );

            let stmts: D1PreparedStatement[] = [];
            let chunkRowsForMap: CsvRow[] = [];
            const BATCH_SIZE = 5000;
            const CONCURRENCY = 1;
            const TOTAL_CHUNK = BATCH_SIZE * CONCURRENCY;
            const localMap: Record<string, number> = {};
            const localAssignments: Array<{ childPk: number; parentId: string }> = [];

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

              if (stmts.length >= TOTAL_CHUNK) {
                await processLocalBatch();
              }
            }
            await processLocalBatch();

            return { processed: processedBytes, header: currentHeader, map: localMap, assignments: localAssignments };
          },
        );

        offset += result.processed;
        headerLine = result.header || "";
        Object.assign(stopMap, result.map);
        parentAssignments.push(...result.assignments);
        chunkIndex++;
      }
    }

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

    const tripsKey = `${prefix}/${GTFS_FILE_NAMES.trips.toLowerCase()}`;
    const tripsObj = await this.env.gtfs_processing.head(tripsKey);
    const tripsSize = tripsObj?.size ?? 0;
    const tripMap: Record<string, number> = {};

    if (tripsSize > 0) {
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
            if (!chunkObj) return { processed: length, header: currentHeader, map: {} };

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

              if (stmts.length >= TOTAL_CHUNK) {
                await processLocalBatch();
              }
            }
            await processLocalBatch();

            return { processed: processedBytes, header: currentHeader, map: localMap };
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

    if (stopTimesSize > 0) {
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
                  nullIfEmpty(row.arrival_time),
                  nullIfEmpty(row.departure_time),
                  nullIfEmpty(row.stop_headsign),
                  intOrNull(row.pickup_type),
                  intOrNull(row.drop_off_type),
                  floatOrNull(row.shape_dist_traveled),
                  intOrNull(row.timepoint),
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

    if (shapesSize > 0) {
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
                  row.shape_id,
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
        const stmt = this.env.gtfs_data.prepare(
          `
          INSERT INTO transfers (
            feed_version_id, from_stop_pk, to_stop_pk, transfer_type, min_transfer_time
          ) VALUES (?, ?, ?, ?, ?)
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
