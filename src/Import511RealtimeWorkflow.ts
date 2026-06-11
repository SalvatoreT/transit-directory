import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  computePacing,
  extractTripUpdateState,
  fetchAndDecodeFeed,
  type RealtimeWorkflowEnv,
} from "./realtime-utils";

interface RealtimeWorkflowParams {
  agencyId: string;
}

interface TripLookupEntry {
  tripPk: number;
  feedSourceId: number;
}

// null entries are negative cache hits: trip ids the feed mentioned but the
// active static GTFS doesn't know. They only become resolvable after a static
// import, which also changes the version key and resets the cache.
type TripLookupAddition = [string, TripLookupEntry | null];

interface IterationResult {
  nowMs: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  processedCount: number;
  versionKey: number | null;
  cacheReset: boolean;
  newLookups: TripLookupAddition[];
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
    const cutoffMs = cutoff.getTime();

    // trip_id -> trip_pk/feed_source_id mapping, cached across iterations:
    // it only changes when a static import activates a new feed version
    // (tracked via versionKey). On engine replay the map is rebuilt
    // deterministically by merging each persisted step result below, so no
    // wall-clock or DB state leaks into control flow.
    const tripLookup = new Map<string, TripLookupEntry | null>();
    let versionKey: number | null = null;

    let iteration = 0;

    console.log(`[${agencyId}] Starting regional realtime workflow.`);

    while (true) {
      iteration++;
      console.log(`[${agencyId}] Starting iteration ${iteration}`);

      const knownVersionKey = versionKey;
      const result = await step.do(
        `Sync TripUpdates - Iteration ${iteration}`,
        async (): Promise<IterationResult> => {
          const url = `https://api.511.org/transit/tripupdates?api_key=${this.env.API_KEY_511}&agency=${agencyId}`;
          const { message, rateLimited, rateLimitLimit, rateLimitRemaining } =
            await fetchAndDecodeFeed(url);

          if (rateLimited || !message) {
            console.warn("Rate limit reached; ending fetch loop early.");
            return {
              nowMs: Date.now(),
              rateLimitLimit,
              rateLimitRemaining: rateLimitRemaining ?? 0,
              processedCount: 0,
              versionKey: knownVersionKey,
              cacheReset: false,
              newLookups: [],
            };
          }

          console.log(
            `Fetched regional TripUpdates. Entities: ${message.entity?.length ?? 0}`,
          );

          const updates = (message.entity || [])
            .map(extractTripUpdateState)
            .filter((u): u is NonNullable<typeof u> => u !== null);

          // The cached lookups become invalid the moment a static import
          // activates a new feed version; one cheap row guards against that.
          const versionRow = await this.env.gtfs_data
            .prepare(
              "SELECT MAX(feed_version_id) AS v FROM feed_version WHERE is_active = 1",
            )
            .first<{ v: number | null }>();
          const currentVersionKey = versionRow?.v ?? null;
          const cacheReset = currentVersionKey !== knownVersionKey;

          const lookupSnapshot = cacheReset
            ? new Map<string, TripLookupEntry | null>()
            : new Map(tripLookup);

          const uniqueTripIds = [...new Set(updates.map((u) => u.tripId))];
          const missingTripIds = uniqueTripIds.filter(
            (id) => !lookupSnapshot.has(id),
          );

          // Look up only unseen trips across active feed versions; results
          // are returned in the step result so the run-scope cache (and any
          // replay) can merge them.
          const newLookups: TripLookupAddition[] = [];
          const CHUNK_SIZE = 50;

          for (let j = 0; j < missingTripIds.length; j += CHUNK_SIZE) {
            const chunk = missingTripIds.slice(j, j + CHUNK_SIZE);
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

            const found = new Map<string, TripLookupEntry>();
            for (const row of results.results || []) {
              found.set(row.trip_id, {
                tripPk: row.trip_pk,
                feedSourceId: row.feed_source_id,
              });
            }
            for (const id of chunk) {
              newLookups.push([id, found.get(id) ?? null]);
            }
          }

          for (const [tripId, entry] of newLookups) {
            lookupSnapshot.set(tripId, entry);
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

          for (const update of updates) {
            const lookup = lookupSnapshot.get(update.tripId);
            if (!lookup) continue;

            batch.push(
              stmt.bind(
                lookup.feedSourceId,
                update.tripId,
                lookup.tripPk,
                update.delay,
                update.status,
                timestamp,
              ),
            );
          }

          const BATCH_SIZE = 50;
          for (let j = 0; j < batch.length; j += BATCH_SIZE) {
            await this.env.gtfs_data.batch(batch.slice(j, j + BATCH_SIZE));
          }

          return {
            nowMs: Date.now(),
            rateLimitLimit,
            rateLimitRemaining,
            processedCount: batch.length,
            versionKey: currentVersionKey,
            cacheReset,
            newLookups,
          };
        },
      );

      if (result.cacheReset) {
        tripLookup.clear();
      }
      versionKey = result.versionKey;
      for (const [tripId, entry] of result.newLookups) {
        tripLookup.set(tripId, entry);
      }

      const pacing = computePacing({
        nowMs: result.nowMs,
        cutoffMs,
        rateLimitRemaining: result.rateLimitRemaining,
      });

      if (!pacing.continueLoop) {
        return;
      }

      await step.sleep(
        `Sleep after TripUpdates - Iteration ${iteration}`,
        `${pacing.sleepSeconds} seconds`,
      );
    }
  }
}
