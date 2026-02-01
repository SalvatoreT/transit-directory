# Suggested Commands (current)

## Install & Dev

- `yarn install`
- `yarn dev` (Astro dev server, default 4321)
- `yarn build`
- `yarn preview`
- `yarn astro check`
- `yarn generate-types`

## Tests

- `yarn test`

## D1 / data

- `yarn wrangler d1 migrations create gtfs_data <message>` — create a new migration.
- `yarn wrangler d1 migrations apply gtfs_data --local` — apply unapplied migrations locally.
- `yarn wrangler d1 migrations apply gtfs_data --remote` — apply unapplied migrations to production.
- `yarn wrangler dev --local --port 8787` — run worker locally.
- `curl http://127.0.0.1:8787/workflow?id=<operator_id>` — trigger GTFS import for a specific agency via the `Import511Workflow`.
- `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"` — trigger cron handler locally while dev server runs.

## Formatting

- `yarn lint` — check formatting with Prettier.
- `yarn format` — format code with Prettier.
- `yarn prettier --write <paths>` — format specific paths.

## Git/inspect

- `git status`
- `git diff`
- `rg "pattern" <path>`
