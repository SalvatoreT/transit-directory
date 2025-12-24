import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
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
    const { agency } = event.payload;

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

      // Before inserting new alerts, we might want to clear old ones for this source?
      // Or upsert? Schema has auto-increment PK.
      // Service alerts usually have an ID.
      // If we want to avoid duplicates over time, we need to track active alerts.
      // For this implementation, I will just insert everything found in the current feed.
      // ideally, we should maybe DELETE FROM service_alerts WHERE feed_source_id = ? before inserting current snapshot?
      // GTFS-RT Service Alerts is usually a snapshot of ALL active alerts.
      // So clearing previous alerts for this source is a reasonable strategy to avoid stale alerts.

      await this.env.gtfs_data
        .prepare("DELETE FROM service_alerts WHERE feed_source_id = ?")
        .bind(feedSourceId)
        .run();

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
        const alertId = entity.id; // Entity ID is typically the alert ID or we check alert.id? Proto definition: FeedEntity has id, Alert message doesn't have separate id usually.

        const a = entity.alert;

        // Helper to get translated text (defaults to first translation or empty)
        const getText = (ts?: transit_realtime.ITranslatedString | null) => {
          if (!ts || !ts.translation || ts.translation.length === 0)
            return null;
          return ts.translation[0].text || null;
        };

        const header = getText(a.headerText);
        const description = getText(a.descriptionText);

        // Time range: use the first active period if available
        let startTime: string | null = null;
        let endTime: string | null = null;
        if (a.activePeriod && a.activePeriod.length > 0) {
          const p = a.activePeriod[0];
          if (p.start)
            startTime = new Date(
              (p.start as any as number) * 1000,
            ).toISOString();
          if (p.end)
            endTime = new Date((p.end as any as number) * 1000).toISOString();
        }

        // Enums
        // Cause: 1=UNKNOWN_CAUSE, etc.
        // Effect: 1=NO_SERVICE, etc.
        // Severity: not standard in basic proto but checking extensions?
        // 511.org might use standard fields. I'll just store enum integers or map if I knew mappings.
        // Schema has TEXT. I will store simple text representation or stringified number.

        const cause = a.cause ? String(a.cause) : null;
        const effect = a.effect ? String(a.effect) : null;
        const severity = a.severityLevel ? String(a.severityLevel) : null;

        // Informed entities
        // If empty, insert one row with nulls? Or skip?
        // Usually global alert if no entities.
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
