import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { transit_realtime } from "./gtfs-realtime";
import {
  fetchAndDecodeFeed,
  getFeedContext,
  type RealtimeWorkflowEnv,
} from "./realtime-utils";

interface RealtimeWorkflowParams {
  agencyId: string;
  waitTimeSeconds: number;
}

export class Import511RealtimeWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  RealtimeWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<RealtimeWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { agencyId, waitTimeSeconds = 60 } = event.payload;
    const start = new Date(event.timestamp);
    const cutoff = new Date(start);
    cutoff.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
    const cutoffTime = cutoff.getTime();

    let iteration = 0;

    console.log(
      `[${agencyId}] Starting workflow. Wait time between calls: ${waitTimeSeconds}s`,
    );

    while (Date.now() < cutoffTime) {
      iteration++;
      console.log(`[${agencyId}] Starting iteration ${iteration}`);

      // --- Trip Updates ---
      const tripUpdatesMetadata = await step.do(
        `[${agencyId}] Sync TripUpdates - Iteration ${iteration}`,
        async () => {
          console.log(`Fetching TripUpdates for ${agencyId}...`);
          const url = `https://api.511.org/transit/tripupdates?api_key=${this.env.API_KEY_511}&agency=${agencyId}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Successfully fetched and decoded TripUpdates for ${agencyId}. Entities: ${message.entity?.length ?? 0}`,
          );

          if (rateLimitRemaining === 0) {
            console.warn(`[${agencyId}] Rate limit reached. Exiting workflow.`);
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: true,
            };
          }

          const { feedSourceId, feedVersionId } = await getFeedContext(
            this.env.gtfs_data,
            agencyId,
          );

          if (!feedVersionId) {
            console.warn(
              `No active feed version for ${agencyId}. skipping processing.`,
            );
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: false,
            };
          }

          const tripIds = (message.entity || [])
            .map((e) => e.tripUpdate?.trip?.tripId)
            .filter((id): id is string => !!id);

          const tripMap = new Map<string, number>();
          if (tripIds.length > 0) {
            const uniqueTripIds = [...new Set(tripIds)];
            const CHUNK_SIZE = 50;
            for (let j = 0; j < uniqueTripIds.length; j += CHUNK_SIZE) {
              const chunk = uniqueTripIds.slice(j, j + CHUNK_SIZE);
              const placeholders = chunk.map(() => "?").join(",");
              const results = await this.env.gtfs_data
                .prepare(
                  `SELECT trip_id, trip_pk FROM trips WHERE feed_version_id = ? AND trip_id IN (${placeholders})`,
                )
                .bind(feedVersionId, ...chunk)
                .all<{ trip_id: string; trip_pk: number }>();

              if (results.results) {
                for (const row of results.results) {
                  tripMap.set(row.trip_id, row.trip_pk);
                }
              }
            }
          }

          const stmt = this.env.gtfs_data.prepare(`
              INSERT OR IGNORE INTO trip_updates (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
              VALUES (?, ?, ?, ?, ?, ?)
          `);

          const batch = [];
          const timestamp = message.header?.timestamp
            ? Number(message.header.timestamp)
            : Math.floor(Date.now() / 1000);

          if (message.entity) {
            for (const entity of message.entity) {
              if (!entity.tripUpdate || !entity.tripUpdate.trip) continue;
              const tripId = entity.tripUpdate.trip.tripId;
              if (!tripId) continue;
              const tripPk = tripMap.get(tripId) || null;
              let effectiveDelay = entity.tripUpdate.delay || 0;
              if (!effectiveDelay && entity.tripUpdate.stopTimeUpdate?.length) {
                const firstUpdate = entity.tripUpdate.stopTimeUpdate[0];
                effectiveDelay =
                  firstUpdate.arrival?.delay ||
                  firstUpdate.departure?.delay ||
                  0;
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
                  feedSourceId,
                  tripId,
                  tripPk,
                  effectiveDelay,
                  status,
                  timestamp,
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

      if (tripUpdatesMetadata.shouldExit) {
        return;
      }

      await step.sleep(
        `[${agencyId}] Sleep after TripUpdates - Iteration ${iteration}`,
        `${waitTimeSeconds} seconds`,
      );

      // --- Service Alerts ---
      const serviceAlertsMetadata = await step.do(
        `[${agencyId}] Sync ServiceAlerts - Iteration ${iteration}`,
        async () => {
          console.log(`Fetching ServiceAlerts for ${agencyId}...`);
          const url = `http://api.511.org/transit/servicealerts?api_key=${this.env.API_KEY_511}&agency=${agencyId}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Successfully fetched and decoded ServiceAlerts for ${agencyId}. Entities: ${message.entity?.length ?? 0}`,
          );

          if (rateLimitRemaining === 0) {
            console.warn(`[${agencyId}] Rate limit reached. Exiting workflow.`);
            return {
              rateLimitLimit,
              rateLimitRemaining,
              processedCount: 0,
              shouldExit: true,
            };
          }

          const { feedSourceId, feedVersionId } = await getFeedContext(
            this.env.gtfs_data,
            agencyId,
          );

          const currentAlertIds = new Set<string>();
          for (const entity of message.entity || []) {
            if (entity.alert && entity.id) {
              currentAlertIds.add(entity.id);
            }
          }

          const now = Math.floor(Date.now() / 1000);
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
              if (row.alert_id && !currentAlertIds.has(row.alert_id)) {
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
            const BATCH_SIZE = 50;
            for (let j = 0; j < closeBatch.length; j += BATCH_SIZE) {
              await this.env.gtfs_data.batch(
                closeBatch.slice(j, j + BATCH_SIZE),
              );
            }
          }

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

          if (feedVersionId) {
            const CHUNK_SIZE = 50;
            const uniqueRouteIds = [...new Set(routeIds)];
            for (let j = 0; j < uniqueRouteIds.length; j += CHUNK_SIZE) {
              const chunk = uniqueRouteIds.slice(j, j + CHUNK_SIZE);
              if (!chunk.length) continue;
              const placeholders = chunk.map(() => "?").join(",");
              const results = await this.env.gtfs_data
                .prepare(
                  `SELECT route_id, route_pk FROM routes WHERE feed_version_id = ? AND route_id IN (${placeholders})`,
                )
                .bind(feedVersionId, ...chunk)
                .all<{ route_id: string; route_pk: number }>();
              if (results.results) {
                for (const row of results.results)
                  routeMap.set(row.route_id, row.route_pk);
              }
            }

            const uniqueStopIds = [...new Set(stopIds)];
            for (let j = 0; j < uniqueStopIds.length; j += CHUNK_SIZE) {
              const chunk = uniqueStopIds.slice(j, j + CHUNK_SIZE);
              if (!chunk.length) continue;
              const placeholders = chunk.map(() => "?").join(",");
              const results = await this.env.gtfs_data
                .prepare(
                  `SELECT stop_id, stop_pk FROM stops WHERE feed_version_id = ? AND stop_id IN (${placeholders})`,
                )
                .bind(feedVersionId, ...chunk)
                .all<{ stop_id: string; stop_pk: number }>();
              if (results.results) {
                for (const row of results.results)
                  stopMap.set(row.stop_id, row.stop_pk);
              }
            }

            const uniqueTripIds = [...new Set(tripIds)];
            for (let j = 0; j < uniqueTripIds.length; j += CHUNK_SIZE) {
              const chunk = uniqueTripIds.slice(j, j + CHUNK_SIZE);
              if (!chunk.length) continue;
              const placeholders = chunk.map(() => "?").join(",");
              const results = await this.env.gtfs_data
                .prepare(
                  `SELECT trip_id, trip_pk FROM trips WHERE feed_version_id = ? AND trip_id IN (${placeholders})`,
                )
                .bind(feedVersionId, ...chunk)
                .all<{ trip_id: string; trip_pk: number }>();
              if (results.results) {
                for (const row of results.results)
                  tripMap.set(row.trip_id, row.trip_pk);
              }
            }
          }

          const stmt = this.env.gtfs_data.prepare(`
              INSERT INTO service_alerts (
                  feed_source_id, alert_id, header, description, cause, effect, 
                  start_time, end_time, severity_level, 
                  affected_route_pk, affected_stop_pk, affected_trip_pk
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          const batch = [];
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
        `[${agencyId}] Sleep after ServiceAlerts - Iteration ${iteration}`,
        `${waitTimeSeconds} seconds`,
      );
    }
  }
}
