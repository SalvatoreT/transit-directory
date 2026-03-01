# Transit Directory (status Mar 2026)

- Astro 5 + TypeScript, Cloudflare adapter/worker entry `src/worker.ts`; Yarn 4.
- Site: https://transit.directory
- D1 schema managed via **migrations** in the `migrations/` folder. Docs in `docs/gtfs-database.md`; `docs/gtfs-reference.md` is GTFS upstream, do not edit.
- Core logic for parsing GTFS CSVs and loading into D1 is contained within `src/Import511Workflow.ts`.
- Real-time GTFS data (trip updates, service alerts) imported via `src/Import511RealtimeWorkflow.ts` (binding `IMPORT_REALTIME_WORKFLOW`).
- Workflow `Import511Workflow` in `src/Import511Workflow.ts` (binding `IMPORT_511_WORKFLOW`) fetches GTFS from 511.org, stores files temporarily in R2, and imports them into D1.
- **Idempotency**: The import workflow calculates a SHA-256 hash of the GTFS zip. If a `feed_version` with that hash already exists, the workflow skips processing and exits early to avoid duplication.
- **Upserts**: D1 imports use `INSERT INTO ... ON CONFLICT (...) DO UPDATE SET ... RETURNING ...` to ensure stability and maintain foreign key integrity.
- Wrangler bindings: D1 `gtfs_data` (database `gtfs-data`), KV `SESSION`, Workflows `IMPORT_511_WORKFLOW` and `IMPORT_REALTIME_WORKFLOW`, R2 `gtfs_processing`.
- Secret `API_KEY_511` is required for fetching data from 511.org.
- **Live Collections**: `src/live.config.ts` defines runtime D1-backed collections (agencies, stops, routes, departures, trips, route_stops, trip_stops) using Astro's experimental `liveContentCollections`.
- **Pages**: `src/pages/index.astro` (agency listing), `src/pages/a/[agency_id].astro` (agency detail with routes/stops toggle), nested routes for `/r/[route_id]`, `/s/[stop_id]`, `/t/[trip_id]`.
- **Components**: `AgencyRoutesView.astro`, `AgencyStopsView.astro`, `DepartureTime.astro`, `StopHero.astro` in `src/components/`.
- **Layout**: `src/layouts/Layout.astro` (HTML shell with OG meta, responsive CSS).
- Key commands: `yarn wrangler d1 migrations apply gtfs_data --local` to apply schema; `yarn dev` then `curl http://127.0.0.1:8788/workflow?id=CT` (example for Caltrain); cron: `curl http://127.0.0.1:8788/cdn-cgi/handler/scheduled`.
