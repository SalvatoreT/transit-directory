# Transit Directory (status Dec 2025)

- Astro 5 + TypeScript, Cloudflare adapter/worker entry `src/worker.ts`; yarn 4.
- D1 schema managed via **migrations** in the `migrations/` folder. Docs in `docs/gtfs-database.md`; `docs/gtfs-reference.md` is GTFS upstream, do not edit.
- Import helper `src/importer.ts` parses GTFS CSVs and loads them into D1 via `importGtfsFeed`.
- Workflow `Import511Workflow` in `src/Import511Workflow.ts` (binding `IMPORT_511_WORKFLOW`) fetches GTFS from 511.org and imports it.
- `/workflow?id=<operator_id>` route in `src/worker.ts` triggers the `Import511Workflow` for a specific agency.
- Cron handler present (logs scheduled time); trigger locally via `/cdn-cgi/handler/scheduled` when running `wrangler dev`.
- Wrangler bindings: D1 `gtfs_data` (database `gtfs-data`), KV `SESSION`, Workflows `IMPORT_511_WORKFLOW`.
- Secret `API_KEY_511` is required for fetching data from 511.org.
- Key commands: `yarn wrangler d1 migrations apply gtfs_data --local` to apply schema; `yarn wrangler dev --local --port 8788` then `curl http://127.0.0.1:8788/workflow?id=CT` (example for Caltrain); cron: `curl http://127.0.0.1:8788/cdn-cgi/handler/scheduled`. No `--persist-to` usage.
- UI: landing at `src/pages/index.astro` using `src/components/Welcome.astro` + `src/layouts/Layout.astro`.
