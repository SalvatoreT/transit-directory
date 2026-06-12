# Transit Directory (status Jun 2026)

- Next.js App Router (react 19) served by **vinext** (Next-on-Vite) on Cloudflare Workers; TypeScript strict; Yarn 4.
- Site: https://transit.directory
- D1 schema managed via **migrations** in the `migrations/` folder. Docs in `docs/gtfs-database.md` (see its "Schema evolution" section for design-vs-live deltas); `docs/gtfs-reference.md` and `docs/gtfs-realtime-reference.md` are GTFS upstream, do not edit.
- Worker entry `worker/index.ts`: wraps vinext's app-router handler with an edge-cache middleware (`worker/cache.ts`: 60s for HTML pages, 1h sitemap/robots, `/api/*` never cached), plus the `scheduled` cron handler and workflow exports.
- **Static import**: `Import511Workflow` (`src/Import511Workflow.ts`, binding `IMPORT_511_WORKFLOW`, daily 08:00 UTC cron per feed source) fetches the GTFS zip from 511.org, hashes it (SHA-256), and:
  - hash matches the active version: skips unzip/R2/import entirely;
  - hash matches an inactive version (crashed import): full re-import into that version id;
  - new content: unzips to R2, imports all tables with the version **inactive**, then atomically activates it in a final step.
  - After every run it deletes versions inactive past `VERSION_RETENTION_SECONDS` (7d) in FK-safe batched passes (`src/cleanup-queries.ts`) and purges `trip_updates` older than 24h.
- **Realtime import**: `Import511RealtimeWorkflow` (`src/Import511RealtimeWorkflow.ts`, binding `IMPORT_REALTIME_WORKFLOW`, hourly cron, agency `RG`) polls 511 trip updates, pacing fetches with the API's RateLimit headers (`computePacing` in `src/realtime-utils.ts`, 15s floor) so coverage spans the whole hour; trip_id->trip_pk lookups are cached across iterations and reset when a new feed version activates. Guarded UPSERT writes only on change.
- **Read path**: `src/db.ts` (D1 access; single-row getters wrapped in React `cache()` for request-level dedup) + `src/db-queries.ts` (pure SQL builders; realtime joins filter `updated_time >= now - REALTIME_STALENESS_SECONDS` (15 min) so stale delays never render as live).
- **Pages**: `app/page.tsx` (agencies), `app/a/[agency_id]/page.tsx`, nested `/r/[route_id]`, `/s/[stop_id]`, `/t/[trip_id]`; `app/sitemap.ts`, `app/robots.ts`. Components in `src/components/` (`DepartureTime.tsx`, `StopHero.tsx`), CSS Modules.
- **TRMNL plugin**: e-ink display endpoints under `app/api/trmnl/*`, logic in `src/lib/trmnl/` (`data.ts` fetch/format, `render.ts` markup). KV `TRMNL_USERS` stores device config.
- Wrangler bindings: D1 `gtfs_data` (database `gtfs-data`), KV `SESSION` + `TRMNL_USERS`, Workflows `IMPORT_511_WORKFLOW` + `IMPORT_REALTIME_WORKFLOW`, R2 `gtfs_processing`. Secret `API_KEY_511`.
- Tests: vitest in `test/` (pure-function suites for pacing, realtime state extraction, query builders, cleanup ordering, cache policy, TRMNL render).
