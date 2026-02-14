import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { transit_realtime } from "./gtfs-realtime";
import { fetchAndDecodeFeed, type RealtimeWorkflowEnv } from "./realtime-utils";

interface RealtimeWorkflowParams {
  agencyId: string;
}

export class Import511RealtimeWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  RealtimeWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<RealtimeWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { agencyId } = event.payload;
    const start = new Date(event.timestamp);
    const cutoff = new Date(start);
    cutoff.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
    const cutoffTime = cutoff.getTime();

    // ~4 requests/minute: 2 requests per iteration with 15s sleep between each
    const WAIT_SECONDS = 15;

    let iteration = 0;

    console.log(`[${agencyId}] Starting regional realtime workflow.`);

    while (Date.now() < cutoffTime) {
      iteration++;
      console.log(`[${agencyId}] Starting iteration ${iteration}`);

      // --- Trip Updates (Regional) ---
      const tripUpdatesMetadata = await step.do(
        `Sync TripUpdates - Iteration ${iteration}`,
        async () => {
          const url = `https://api.511.org/transit/tripupdates?api_key=${this.env.API_KEY_511}&agency=${agencyId}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Fetched regional TripUpdates. Entities: ${message.entity?.length ?? 0}`,
          );

          if (rateLimitRemaining === 0) {
            console.warn("Rate limit reached. Exiting workflow.");
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: true,
            };
          }

          const tripIds = (message.entity || [])
            .map((e) => e.tripUpdate?.trip?.tripId)
            .filter((id): id is string => !!id);

          if (tripIds.length === 0) {
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: false,
            };
          }

          // Look up trips across all active feed versions to get trip_pk and feed_source_id
          const uniqueTripIds = [...new Set(tripIds)];
          const tripLookup = new Map<
            string,
            { tripPk: number; feedSourceId: number }
          >();
          const CHUNK_SIZE = 50;

          for (let j = 0; j < uniqueTripIds.length; j += CHUNK_SIZE) {
            const chunk = uniqueTripIds.slice(j, j + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const results = await this.env.gtfs_data
              .prepare(
                `SELECT t.trip_id, t.trip_pk, fv.feed_source_id
                 FROM trips t
                 JOIN feed_version fv ON t.feed_version_id = fv.feed_version_id
                 WHERE fv.is_active = 1 AND t.trip_id IN (${placeholders})`,
              )
              .bind(...chunk)
              .all<{
                trip_id: string;
                trip_pk: number;
                feed_source_id: number;
              }>();

            if (results.results) {
              for (const row of results.results) {
                tripLookup.set(row.trip_id, {
                  tripPk: row.trip_pk,
                  feedSourceId: row.feed_source_id,
                });
              }
            }
          }

          const stmt = this.env.gtfs_data.prepare(`
              INSERT OR IGNORE INTO trip_updates (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
              VALUES (?, ?, ?, ?, ?, ?)
          `);

          const batch: D1PreparedStatement[] = [];
          const timestamp = message.header?.timestamp
            ? Number(message.header.timestamp)
            : Math.floor(Date.now() / 1000);

          for (const entity of message.entity || []) {
            if (!entity.tripUpdate || !entity.tripUpdate.trip) continue;
            const tripId = entity.tripUpdate.trip.tripId;
            if (!tripId) continue;

            const lookup = tripLookup.get(tripId);
            if (!lookup) continue;

            let effectiveDelay = entity.tripUpdate.delay || 0;
            if (!effectiveDelay && entity.tripUpdate.stopTimeUpdate?.length) {
              const firstUpdate = entity.tripUpdate.stopTimeUpdate[0];
              effectiveDelay =
                firstUpdate.arrival?.delay || firstUpdate.departure?.delay || 0;
            }

            let status = "SCHEDULED";
            if (entity.tripUpdate.trip.scheduleRelationship) {
              const rel = entity.tripUpdate.trip.scheduleRelationship;
              if (rel === 1) status = "ADDED";
              if (rel === 2) status = "UNSCHEDULED";
              if (rel === 3) status = "CANCELED";
            }

            batch.push(
              stmt.bind(
                lookup.feedSourceId,
                tripId,
                lookup.tripPk,
                effectiveDelay,
                status,
                timestamp,
              ),
            );
          }

          const BATCH_SIZE = 50;
          for (let j = 0; j < batch.length; j += BATCH_SIZE) {
            await this.env.gtfs_data.batch(batch.slice(j, j + BATCH_SIZE));
          }

          return {
            rateLimitLimit,
            rateLimitRemaining,
            processedCount: batch.length,
            shouldExit: false,
          };
        },
      );

      if (tripUpdatesMetadata.shouldExit) {
        return;
      }

      await step.sleep(
        `Sleep after TripUpdates - Iteration ${iteration}`,
        `${WAIT_SECONDS} seconds`,
      );

      // --- Service Alerts (Regional) ---
      const serviceAlertsMetadata = await step.do(
        `Sync ServiceAlerts - Iteration ${iteration}`,
        async () => {
          const url = `https://api.511.org/transit/servicealerts?api_key=${this.env.API_KEY_511}&agency=${agencyId}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Fetched regional ServiceAlerts. Entities: ${message.entity?.length ?? 0}`,
          );

          if (rateLimitRemaining === 0) {
            console.warn("Rate limit reached. Exiting workflow.");
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: true,
            };
          }

          // Build mapping: GTFS agency_id -> feed_source_id
          const agencyToFeedSource = new Map<string, number>();
          const agencyResults = await this.env.gtfs_data
            .prepare(
              `SELECT a.agency_id, fv.feed_source_id
               FROM agency a
               JOIN feed_version fv ON a.feed_version_id = fv.feed_version_id
               WHERE fv.is_active = 1`,
            )
            .all<{ agency_id: string; feed_source_id: number }>();
          if (agencyResults.results) {
            for (const row of agencyResults.results) {
              if (row.agency_id) {
                agencyToFeedSource.set(row.agency_id, row.feed_source_id);
              }
            }
          }

          // Also map source_name -> feed_source_id as fallback
          const sourceNameToFeedSource = new Map<string, number>();
          const sourceResults = await this.env.gtfs_data
            .prepare("SELECT feed_source_id, source_name FROM feed_source")
            .all<{ feed_source_id: number; source_name: string }>();
          if (sourceResults.results) {
            for (const row of sourceResults.results) {
              sourceNameToFeedSource.set(row.source_name, row.feed_source_id);
            }
          }

          // Get all active feed_source_ids
          const activeFeedSources = new Set<number>();
          const activeResults = await this.env.gtfs_data
            .prepare(
              "SELECT DISTINCT feed_source_id FROM feed_version WHERE is_active = 1",
            )
            .all<{ feed_source_id: number }>();
          if (activeResults.results) {
            for (const row of activeResults.results) {
              activeFeedSources.add(row.feed_source_id);
            }
          }

          // Resolve feed_source_id from an informed entity's agencyId
          const resolveFeedSourceId = (ie: {
            agencyId?: string | null;
          }): number | null => {
            if (ie.agencyId) {
              const fsId = agencyToFeedSource.get(ie.agencyId);
              if (fsId) return fsId;
              const fsId2 = sourceNameToFeedSource.get(ie.agencyId);
              if (fsId2) return fsId2;
            }
            return null;
          };

          // Collect current alert IDs per feed_source from the regional feed
          const currentAlertsBySource = new Map<number, Set<string>>();
          for (const entity of message.entity || []) {
            if (!entity.alert || !entity.id) continue;
            for (const ie of entity.alert.informedEntity || []) {
              const feedSourceId = resolveFeedSourceId(ie);
              if (feedSourceId) {
                if (!currentAlertsBySource.has(feedSourceId)) {
                  currentAlertsBySource.set(feedSourceId, new Set());
                }
                currentAlertsBySource.get(feedSourceId)!.add(entity.id);
              }
            }
          }

          // Close alerts no longer in the regional feed
          const now = Math.floor(Date.now() / 1000);
          for (const feedSourceId of activeFeedSources) {
            const currentIds =
              currentAlertsBySource.get(feedSourceId) || new Set();

            const activeAlerts = await this.env.gtfs_data
              .prepare(
                `SELECT alert_pk, alert_id FROM service_alerts
                 WHERE feed_source_id = ? AND (end_time IS NULL OR end_time > ?)`,
              )
              .bind(feedSourceId, now)
              .all<{ alert_pk: number; alert_id: string }>();

            const alertsToClose: number[] = [];
            if (activeAlerts.results) {
              for (const row of activeAlerts.results) {
                if (row.alert_id && !currentIds.has(row.alert_id)) {
                  alertsToClose.push(row.alert_pk);
                }
              }
            }

            if (alertsToClose.length > 0) {
              const closeStmt = this.env.gtfs_data.prepare(
                "UPDATE service_alerts SET end_time = ? WHERE alert_pk = ?",
              );
              const closeBatch = alertsToClose.map((pk) =>
                closeStmt.bind(now, pk),
              );
              const CLOSE_BATCH_SIZE = 50;
              for (let j = 0; j < closeBatch.length; j += CLOSE_BATCH_SIZE) {
                await this.env.gtfs_data.batch(
                  closeBatch.slice(j, j + CLOSE_BATCH_SIZE),
                );
              }
            }
          }

          // Resolve route/stop/trip PKs for alert entities across all active feeds
          const routeIds: string[] = [];
          const stopIds: string[] = [];
          const tripIds: string[] = [];

          for (const entity of message.entity || []) {
            if (!entity.alert) continue;
            for (const ie of entity.alert.informedEntity || []) {
              if (ie.routeId) routeIds.push(ie.routeId);
              if (ie.stopId) stopIds.push(ie.stopId);
              if (ie.trip?.tripId) tripIds.push(ie.trip.tripId);
            }
          }

          const routeMap = new Map<string, number>();
          const stopMap = new Map<string, number>();
          const tripMap = new Map<string, number>();

          const CHUNK_SIZE = 50;

          const uniqueRouteIds = [...new Set(routeIds)];
          for (let j = 0; j < uniqueRouteIds.length; j += CHUNK_SIZE) {
            const chunk = uniqueRouteIds.slice(j, j + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const results = await this.env.gtfs_data
              .prepare(
                `SELECT r.route_id, r.route_pk FROM routes r
                 JOIN feed_version fv ON r.feed_version_id = fv.feed_version_id
                 WHERE fv.is_active = 1 AND r.route_id IN (${placeholders})`,
              )
              .bind(...chunk)
              .all<{ route_id: string; route_pk: number }>();
            if (results.results) {
              for (const row of results.results)
                routeMap.set(row.route_id, row.route_pk);
            }
          }

          const uniqueStopIds = [...new Set(stopIds)];
          for (let j = 0; j < uniqueStopIds.length; j += CHUNK_SIZE) {
            const chunk = uniqueStopIds.slice(j, j + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const results = await this.env.gtfs_data
              .prepare(
                `SELECT s.stop_id, s.stop_pk FROM stops s
                 JOIN feed_version fv ON s.feed_version_id = fv.feed_version_id
                 WHERE fv.is_active = 1 AND s.stop_id IN (${placeholders})`,
              )
              .bind(...chunk)
              .all<{ stop_id: string; stop_pk: number }>();
            if (results.results) {
              for (const row of results.results)
                stopMap.set(row.stop_id, row.stop_pk);
            }
          }

          const uniqueTripIds = [...new Set(tripIds)];
          for (let j = 0; j < uniqueTripIds.length; j += CHUNK_SIZE) {
            const chunk = uniqueTripIds.slice(j, j + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            const results = await this.env.gtfs_data
              .prepare(
                `SELECT t.trip_id, t.trip_pk FROM trips t
                 JOIN feed_version fv ON t.feed_version_id = fv.feed_version_id
                 WHERE fv.is_active = 1 AND t.trip_id IN (${placeholders})`,
              )
              .bind(...chunk)
              .all<{ trip_id: string; trip_pk: number }>();
            if (results.results) {
              for (const row of results.results)
                tripMap.set(row.trip_id, row.trip_pk);
            }
          }

          // Insert alerts
          const stmt = this.env.gtfs_data.prepare(`
              INSERT INTO service_alerts (
                  feed_source_id, alert_id, header, description, cause, effect,
                  start_time, end_time, severity_level,
                  affected_route_pk, affected_stop_pk, affected_trip_pk
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const batch: D1PreparedStatement[] = [];
          for (const entity of message.entity || []) {
            if (!entity.alert) continue;
            const alertId = entity.id;
            const a = entity.alert;
            const getText = (
              ts?: transit_realtime.ITranslatedString | null,
            ) => {
              if (!ts || !ts.translation || ts.translation.length === 0)
                return null;
              return ts.translation[0].text || null;
            };
            const header = getText(a.headerText);
            const description = getText(a.descriptionText);
            let startTime: number | null = null;
            let endTime: number | null = null;
            if (a.activePeriod && a.activePeriod.length > 0) {
              const p = a.activePeriod[0];
              if (p.start) startTime = Math.floor(Number(p.start));
              if (p.end) endTime = Math.floor(Number(p.end));
            }
            const cause = a.cause ? String(a.cause) : null;
            const effect = a.effect ? String(a.effect) : null;
            const severity = a.severityLevel ? String(a.severityLevel) : null;
            const entities =
              a.informedEntity && a.informedEntity.length > 0
                ? a.informedEntity
                : [{}];
            for (const ie of entities) {
              const feedSourceId = resolveFeedSourceId(ie);
              if (!feedSourceId) continue;

              const routePk = ie.routeId
                ? routeMap.get(ie.routeId) || null
                : null;
              const stopPk = ie.stopId ? stopMap.get(ie.stopId) || null : null;
              const tripPk = ie.trip?.tripId
                ? tripMap.get(ie.trip.tripId) || null
                : null;
              batch.push(
                stmt.bind(
                  feedSourceId,
                  alertId,
                  header,
                  description,
                  cause,
                  effect,
                  startTime,
                  endTime,
                  severity,
                  routePk,
                  stopPk,
                  tripPk,
                ),
              );
            }
          }

          const BATCH_SIZE = 50;
          for (let j = 0; j < batch.length; j += BATCH_SIZE) {
            await this.env.gtfs_data.batch(batch.slice(j, j + BATCH_SIZE));
          }

          return {
            rateLimitLimit,
            rateLimitRemaining,
            processedCount: batch.length,
            shouldExit: false,
          };
        },
      );

      if (serviceAlertsMetadata.shouldExit) {
        return;
      }

      await step.sleep(
        `Sleep after ServiceAlerts - Iteration ${iteration}`,
        `${WAIT_SECONDS} seconds`,
      );
    }
  }
}
