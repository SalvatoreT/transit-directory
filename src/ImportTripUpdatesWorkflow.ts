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

export class ImportTripUpdatesWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  RealtimeWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<RealtimeWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { agency } = event.payload;

    await step.do(`[TripUpdates] Process ${agency}`, async () => {
      const url = `https://api.511.org/transit/tripupdates?api_key=${this.env.API_KEY_511}&agency=${agency}`;

      // Fetch and decode
      const message = await fetchAndDecodeFeed(url);
      console.log(
        `Fetched TripUpdates for ${agency}. Entities: ${message.entity.length}`,
      );

      // Get DB context
      const { feedSourceId, feedVersionId } = await getFeedContext(
        this.env.gtfs_data,
        agency,
      );

      if (!feedVersionId) {
        console.warn(
          `No active feed version for ${agency}. Skipping trip lookup.`,
        );
      }

      const updatesToInsert = [];

      // We need to resolve trip_pk for each update
      // To be efficient, we can batch collect trip_ids and query them, or just do individual lookups if not too many.
      // For simplicity and to avoid complex batching logic in this iteration, let's try to prepare a map first.

      const tripIds = message.entity
        .map((e) => e.tripUpdate?.trip?.tripId)
        .filter((id): id is string => !!id);

      const tripMap = new Map<string, number>();
      if (feedVersionId && tripIds.length > 0) {
        // Fetch trip_pks for these trip_ids
        // Note: In D1/SQLite, 'IN' clause limit is usually around 1000.
        // If we have many entities, we might need to chunk.
        const uniqueTripIds = [...new Set(tripIds)];
        const CHUNK_SIZE = 50;
        for (let i = 0; i < uniqueTripIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueTripIds.slice(i, i + CHUNK_SIZE);
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
          INSERT INTO trip_updates (feed_source_id, trip_id, trip_pk, delay, status, updated_time)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(feed_source_id, trip_id) DO UPDATE SET
            trip_pk = excluded.trip_pk,
            delay = excluded.delay,
            status = excluded.status,
            updated_time = excluded.updated_time
        `);

      const batch = [];
      const timestamp = new Date(
        ((message.header.timestamp as any as number) || Date.now() / 1000) *
          1000,
      ).toISOString();

      for (const entity of message.entity) {
        if (!entity.tripUpdate) continue;

        const tripId = entity.tripUpdate.trip.tripId;
        if (!tripId) continue;

        const tripPk = tripMap.get(tripId) || null;
        const delay = entity.tripUpdate.delay || 0; // Top level delay? usually not there.

        // Try to find the first stop_time_update with a delay if top level is missing
        let effectiveDelay = delay;
        if (!effectiveDelay && entity.tripUpdate.stopTimeUpdate?.length) {
          const firstUpdate = entity.tripUpdate.stopTimeUpdate[0];
          effectiveDelay =
            firstUpdate.arrival?.delay || firstUpdate.departure?.delay || 0;
        }

        // Status?
        // GTFS-RT doesn't have a simple 'status' string on tripUpdate usually, maybe verify schema intention.
        // Schema says 'status' TEXT. Could be 'CANCELED', 'ADDED', 'SCHEDULED'.
        // entity.tripUpdate.trip.scheduleRelationship
        let status = "SCHEDULED";
        if (entity.tripUpdate.trip.scheduleRelationship) {
          // Map enum to string
          // 0=SCHEDULED, 1=ADDED, 2=UNSCHEDULED, 3=CANCELED
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

      if (batch.length > 0) {
        // D1 batch limit is also a consideration, but let's try pushing it.
        // Split into reasonable chunks
        const BATCH_SIZE = 50;
        for (let i = 0; i < batch.length; i += BATCH_SIZE) {
          await this.env.gtfs_data.batch(batch.slice(i, i + BATCH_SIZE));
        }
      }

      return { processed: batch.length };
    });
  }
}
