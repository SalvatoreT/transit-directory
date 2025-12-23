# Transit Directory (status Dec 2025)

- Astro 5 + TypeScript, Cloudflare adapter/worker entry `src/worker.ts`; yarn 4.
- D1 schema managed via **migrations** in the `migrations/` folder. Docs in `docs/gtfs-database.md`; `docs/gtfs-reference.md` is GTFS upstream, do not edit.
- Core logic for parsing GTFS CSVs and loading into D1 is contained within `src/Import511Workflow.ts`.
- Workflow `Import511Workflow` in `src/Import511Workflow.ts` (binding `IMPORT_511_WORKFLOW`) fetches GTFS from 511.org, stores files temporarily in R2, and imports them into D1.
- **Idempotency**: The import workflow calculates a SHA-256 hash of the GTFS zip. If a `feed_version` with that hash already exists, the workflow skips processing and exits early to avoid duplication.
- **Upserts**: D1 imports use `INSERT INTO ... ON CONFLICT (...) DO UPDATE SET ... RETURNING ...` to ensure stability and maintain foreign key integrity.
- Wrangler bindings: D1 `gtfs_data` (database `gtfs-data`), KV `SESSION`, Workflows `IMPORT_511_WORKFLOW`, R2 `gtfs_processing`.
- Secret `API_KEY_511` is required for fetching data from 511.org.
- Key commands: `yarn wrangler d1 migrations apply gtfs_data --local` to apply schema; `yarn wrangler dev --local --port 8788` then `curl http://127.0.0.1:8788/workflow?id=CT` (example for Caltrain); cron: `curl http://127.0.0.1:8788/cdn-cgi/handler/scheduled`. No `--persist-to` usage.
- UI: landing at `src/pages/index.astro` using `src/components/Welcome.astro` + `src/layouts/Layout.astro`.
