import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { fetchAndDecodeFeed, type RealtimeWorkflowEnv } from "./realtime-utils";

// Regional feeds prefix trip/route/stop IDs with "{agency}:" (e.g. "BA:1841778").
// Static GTFS stores them without the prefix, so we strip it before DB lookups.
function stripAgencyPrefix(id: string): string {
  const idx = id.indexOf(":");
  return idx >= 0 ? id.substring(idx + 1) : id;
}

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

    // ~4 requests/minute: one TripUpdates fetch per iteration with 15s sleep after.
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
            .filter((id): id is string => !!id)
            .map(stripAgencyPrefix);

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

          // Upsert one row per (feed_source_id, trip_id). The DO UPDATE is
          // guarded so a fetch that brings back identical state (same delay,
          // status, trip_pk, and a stale-or-equal timestamp) is a no-op and
          // writes nothing - no row update, no index churn.
          const stmt = this.env.gtfs_data.prepare(`
              INSERT INTO trip_updates (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(feed_source_id, trip_id) DO UPDATE SET
                  trip_pk      = excluded.trip_pk,
                  delay        = excluded.delay,
                  status       = excluded.status,
                  updated_time = excluded.updated_time
              WHERE excluded.updated_time > trip_updates.updated_time
                 OR excluded.delay   IS NOT trip_updates.delay
                 OR excluded.status  IS NOT trip_updates.status
                 OR excluded.trip_pk IS NOT trip_updates.trip_pk
          `);

          const batch: D1PreparedStatement[] = [];
          const timestamp = message.header?.timestamp
            ? Number(message.header.timestamp)
            : Math.floor(Date.now() / 1000);

          for (const entity of message.entity || []) {
            if (!entity.tripUpdate || !entity.tripUpdate.trip) continue;
            const rawTripId = entity.tripUpdate.trip.tripId;
            if (!rawTripId) continue;

            const tripId = stripAgencyPrefix(rawTripId);
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
    }
  }
}
