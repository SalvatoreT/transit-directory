# Suggested Commands (current)

## Install & Dev

- `yarn install`
- `yarn dev` (vinext dev server)
- `yarn build` (vinext production build to `dist/`)
- `yarn preview` (serve the production build)
- `yarn deploy` (build + deploy to Cloudflare Workers)
- `yarn generate-types` (regenerate `worker-configuration.d.ts`)

## Tests

- `yarn test` (vitest)

## D1 / data

- `yarn wrangler d1 migrations create gtfs_data <message>` -- create a new migration.
- `yarn wrangler d1 migrations apply gtfs_data --local` -- apply unapplied migrations locally.
- `yarn wrangler d1 migrations apply gtfs_data --remote` -- apply unapplied migrations to production.
- `yarn wrangler d1 execute gtfs_data --local --command "<SQL>"` -- run SQL against local D1.
- `yarn wrangler dev` then `curl "http://127.0.0.1:8787/workflow?id=<operator_id>"` -- trigger GTFS import for a specific agency via `Import511Workflow`.
- `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"` -- trigger the cron handler locally while `yarn wrangler dev` runs.

## Formatting

- `yarn lint` -- check formatting with Prettier.
- `yarn format` -- format code with Prettier.
