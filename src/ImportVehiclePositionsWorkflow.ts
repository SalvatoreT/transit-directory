import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import {
  fetchAndDecodeFeed,
  getFeedContext,
  type RealtimeWorkflowEnv,
  type RealtimeWorkflowParams,
} from "./realtime-utils";

export class ImportVehiclePositionsWorkflow extends WorkflowEntrypoint<
  RealtimeWorkflowEnv,
  RealtimeWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<RealtimeWorkflowParams>>,
    step: WorkflowStep,
  ) {
    const { agency } = event.payload;

    await step.do(`[VehiclePositions] Process ${agency}`, async () => {
      const url = `http://api.511.org/transit/vehiclepositions?api_key=${this.env.API_KEY_511}&agency=${agency}`;

      const message = await fetchAndDecodeFeed(url);
      console.log(
        `Fetched VehiclePositions for ${agency}. Entities: ${message.entity.length}`,
      );

      const { feedSourceId, feedVersionId } = await getFeedContext(
        this.env.gtfs_data,
        agency,
      );

      if (!feedVersionId) {
        console.warn(`No active feed version for ${agency}. Skipping lookups.`);
      }

      // Collect IDs for lookup
      const tripIds: string[] = [];
      const routeIds: string[] = [];

      for (const entity of message.entity) {
        if (entity.vehicle?.trip?.tripId)
          tripIds.push(entity.vehicle.trip.tripId);
        if (entity.vehicle?.trip?.routeId)
          routeIds.push(entity.vehicle.trip.routeId);
      }

      const tripMap = new Map<string, number>();
      const routeMap = new Map<string, number>();

      if (feedVersionId) {
        // Lookup Trips
        const uniqueTripIds = [...new Set(tripIds)];
        const CHUNK_SIZE = 50;
        for (let i = 0; i < uniqueTripIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueTripIds.slice(i, i + CHUNK_SIZE);
          if (chunk.length === 0) continue;
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

        // Lookup Routes
        const uniqueRouteIds = [...new Set(routeIds)];
        for (let i = 0; i < uniqueRouteIds.length; i += CHUNK_SIZE) {
          const chunk = uniqueRouteIds.slice(i, i + CHUNK_SIZE);
          if (chunk.length === 0) continue;
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
      }

      const stmt = this.env.gtfs_data.prepare(`
            INSERT INTO vehicle_positions (
                feed_source_id, vehicle_id, trip_pk, route_pk, 
                latitude, longitude, speed, heading, timestamp, 
                current_status, occupancy_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

      const batch = [];

      for (const entity of message.entity) {
        if (!entity.vehicle) continue;

        const v = entity.vehicle;
        const vehicleId = v.vehicle?.id; // vehicle.vehicle.id
        if (!vehicleId) continue;

        const tripPk = v.trip?.tripId
          ? tripMap.get(v.trip.tripId) || null
          : null;
        const routePk = v.trip?.routeId
          ? routeMap.get(v.trip.routeId) || null
          : null;

        // Enums
        let currentStatus = "IN_TRANSIT_TO";
        if (v.currentStatus === 0) currentStatus = "INCOMING_AT";
        if (v.currentStatus === 1) currentStatus = "STOPPED_AT";
        if (v.currentStatus === 2) currentStatus = "IN_TRANSIT_TO";

        let occupancyStatus = "EMPTY";
        // Map occupancy status if needed, proto usually has values like 0=EMPTY, 1=MANY_SEATS_AVAILABLE etc.
        // For now just storing stringified or default?
        // Let's just store the enum text if possible or raw value?
        // Schema is TEXT. Let's try to map a few common ones.
        // But the generated type is numeric enum.
        // Simplest is to just null or default unless we have specific mapping requirements.
        // I'll leave it nullable/default for now or mapped simply.
        if (v.occupancyStatus !== undefined && v.occupancyStatus !== null) {
          // basic mapping
          const occ = [
            "EMPTY",
            "MANY_SEATS_AVAILABLE",
            "FEW_SEATS_AVAILABLE",
            "STANDING_ROOM_ONLY",
            "CRUSHED_STANDING_ROOM_ONLY",
            "FULL",
            "NOT_ACCEPTING_PASSENGERS",
          ];
          occupancyStatus = occ[v.occupancyStatus] || "UNKNOWN";
        } else {
          occupancyStatus = "";
        }

        const timestamp = v.timestamp
          ? new Date((v.timestamp as any as number) * 1000).toISOString()
          : new Date().toISOString();

        batch.push(
          stmt.bind(
            feedSourceId,
            vehicleId,
            tripPk,
            routePk,
            v.position?.latitude || null,
            v.position?.longitude || null,
            v.position?.speed || null,
            v.position?.bearing || null,
            timestamp,
            currentStatus,
            occupancyStatus,
          ),
        );
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
