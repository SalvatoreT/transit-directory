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
  type RealtimeWorkflowParams,
} from "./realtime-utils";

export class ImportServiceAlertsWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  RealtimeWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<RealtimeWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { agency, delayStart } = event.payload;

    if (delayStart && delayStart > 0) {
      await step.sleep(
        `[ServiceAlerts] Delay start ${delayStart}s`,
        `${delayStart} seconds`,
      );
    }

    await step.do(`[ServiceAlerts] Process ${agency}`, async () => {
      const url = `http://api.511.org/transit/servicealerts?api_key=${this.env.API_KEY_511}&agency=${agency}`;

      const message = await fetchAndDecodeFeed(url);
      console.log(
        `Fetched ServiceAlerts for ${agency}. Entities: ${message.entity.length}`,
      );

      const { feedSourceId, feedVersionId } = await getFeedContext(
        this.env.gtfs_data,
        agency,
      );

      // Handle missing alerts: Close them by setting end_time to now
      const currentAlertIds = new Set<string>();
      for (const entity of message.entity) {
        if (entity.alert && entity.id) {
          currentAlertIds.add(entity.id);
        }
      }

      // Use Unix timestamp (seconds)
      const now = Math.floor(Date.now() / 1000);

      // Fetch active alerts from DB
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
        console.log(`Closing ${alertsToClose.length} missing service alerts.`);
        const closeStmt = this.env.gtfs_data.prepare(
          "UPDATE service_alerts SET end_time = ? WHERE alert_pk = ?",
        );
        const closeBatch = alertsToClose.map((pk) => closeStmt.bind(now, pk));

        const BATCH_SIZE = 50;
        for (let i = 0; i < closeBatch.length; i += BATCH_SIZE) {
          await this.env.gtfs_data.batch(closeBatch.slice(i, i + BATCH_SIZE));
        }
      }

      // Pre-fetch lookups if we want to resolve route/stop/trip PKs
      // Service alerts can refer to routeId, stopId, tripId.
      const routeIds: string[] = [];
      const stopIds: string[] = [];
      const tripIds: string[] = [];

      for (const entity of message.entity) {
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

        // Routes
        const uniqueRouteIds = [...new Set(routeIds)];
        for (let i = 0; i < uniqueRouteIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueRouteIds.slice(i, i + CHUNK_SIZE);
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

        // Stops
        const uniqueStopIds = [...new Set(stopIds)];
        for (let i = 0; i < uniqueStopIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueStopIds.slice(i, i + CHUNK_SIZE);
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

        // Trips
        const uniqueTripIds = [...new Set(tripIds)];
        for (let i = 0; i < uniqueTripIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueTripIds.slice(i, i + CHUNK_SIZE);
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

      for (const entity of message.entity) {
        if (!entity.alert) continue;
        const alertId = entity.id;

        const a = entity.alert;

        const getText = (ts?: transit_realtime.ITranslatedString | null) => {
          if (!ts || !ts.translation || ts.translation.length === 0)
            return null;
          return ts.translation[0].text || null;
        };

        const header = getText(a.headerText);
        const description = getText(a.descriptionText);

        // Time range: use the first active period if available
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
          const routePk = ie.routeId ? routeMap.get(ie.routeId) || null : null;
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

      if (batch.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < batch.length; i += BATCH_SIZE) {
          await this.env.gtfs_data.batch(batch.slice(i, i + BATCH_SIZE));
        }
      }

      return { processed: batch.length };
    });
  }
}
