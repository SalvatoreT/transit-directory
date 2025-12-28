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

export class Import511RealtimeWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  {}
> {
  async run(event: Readonly<WorkflowEvent<{}>>, step: WorkflowStep) {
    const start = new Date(event.timestamp);
    const cutoff = new Date(start);
    cutoff.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
    const cutoffTime = cutoff.getTime();

    const agencies = await step.do("Fetch Agencies", async () => {
      console.log("Fetching agencies from database...");
      const { results } = await this.env.gtfs_data
        .prepare("SELECT source_name FROM feed_source")
        .all<{ source_name: string }>();
      console.log(`Found ${results.length} agencies.`);
      return results.map((r) => r.source_name);
    });

    if (agencies.length === 0) {
      console.log("No agencies found. Exiting workflow.");
      return;
    }

    // Default to spreading across 1 hour (3600 seconds) if headers are missing
    let secondsToSpread = 3600;
    let requestsAllowedInWindow = 60;

    for (let i = 0; i < agencies.length; i++) {
      if (Date.now() > cutoffTime) {
        console.log("Workflow exceeded 1 hour. Stopping.");
        return;
      }

      const agency = agencies[i];
      console.log(`Processing agency: ${agency} (${i + 1}/${agencies.length})`);

      // --- Trip Updates ---
      const tripUpdatesMetadata = await step.do(
        `[${agency}] Sync TripUpdates`,
        async () => {
          console.log(`Fetching TripUpdates for ${agency}...`);
          const url = `https://api.511.org/transit/tripupdates?api_key=${this.env.API_KEY_511}&agency=${agency}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Successfully fetched and decoded TripUpdates for ${agency}. Entities: ${message.entity?.length ?? 0}`,
          );

          const { feedSourceId, feedVersionId } = await getFeedContext(
            this.env.gtfs_data,
            agency,
          );

          if (!feedVersionId) {
            console.warn(
              `No active feed version for ${agency}. skipping processing.`,
            );
            return { rateLimitLimit, rateLimitRemaining, processedCount: 0 };
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
          };
        },
      );

      // Update rate limit info from headers
      if (tripUpdatesMetadata.rateLimitLimit) {
        requestsAllowedInWindow = tripUpdatesMetadata.rateLimitLimit;
      }

      // Proactive sleep if we are out of quota
      if (tripUpdatesMetadata.rateLimitRemaining === 0) {
        await step.sleep(
          `[${agency}] TripUpdates: Rate limit reached, waiting 300s`,
          `300 seconds`,
        );

        // Check again after a long sleep
        if (Date.now() > cutoffTime) {
          return;
        }
      }

      // Calculate sleep between requests
      const intervalSeconds = Math.floor(
        secondsToSpread / requestsAllowedInWindow,
      );
      await step.sleep(
        `[${agency}] Sleep after TripUpdates`,
        `${intervalSeconds} seconds`,
      );

      // --- Service Alerts ---
      const serviceAlertsMetadata = await step.do(
        `[${agency}] Sync ServiceAlerts`,
        async () => {
          console.log(`Fetching ServiceAlerts for ${agency}...`);
          const url = `http://api.511.org/transit/servicealerts?api_key=${this.env.API_KEY_511}&agency=${agency}`;
          const { message, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);
          console.log(
            `Successfully fetched and decoded ServiceAlerts for ${agency}. Entities: ${message.entity?.length ?? 0}`,
          );

          const { feedSourceId, feedVersionId } = await getFeedContext(
            this.env.gtfs_data,
            agency,
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
          };
        },
      );

      // Proactive sleep if we are out of quota
      if (serviceAlertsMetadata.rateLimitRemaining === 0) {
        await step.sleep(
          `[${agency}] ServiceAlerts: Rate limit reached, waiting 300s`,
          `300 seconds`,
        );

        if (Date.now() > cutoffTime) {
          return;
        }
      }

      // Sleep after ServiceAlerts if it's not the last one
      if (i < agencies.length - 1) {
        await step.sleep(
          `[${agency}] Sleep after ServiceAlerts`,
          `${intervalSeconds} seconds`,
        );
      }
    }
  }
}
