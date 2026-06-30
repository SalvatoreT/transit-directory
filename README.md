# Transit Directory

Bay Area transit departures at [transit.directory](https://transit.directory).

A Next.js App Router app served by vinext on Cloudflare Workers:

- **D1** (binding `gtfs_data`) stores GTFS static data; schema is managed via
  `migrations/`.
- **R2** (binding `gtfs_processing`) stages unzipped GTFS files during imports.
- **Workflow**: `Import511Workflow` runs daily (08:00 UTC cron) per feed source,
  importing the static GTFS zip from 511.org and skipping all work when the zip
  is unchanged.
- **Realtime**: GTFS-RT TripUpdates (agency `RG`) are fetched on page load and
  merged into departures; the raw payload is cached in the Cloudflare Cache API
  (`src/realtime-feed.ts`) so 511.org is polled at most once per ~15s.
- **Edge cache**: HTML pages and the sitemap are cached briefly at the edge
  (`worker/cache.ts`); `/api/*` is never cached.
- **TRMNL plugin** endpoints live under `/api/trmnl/*` (see
  `docs/trmnl-setup.md`).

# Setup

```sh
yarn install
```

Then to run the development server:

```sh
yarn dev
```

## D1 GTFS database

- Schema managed via **migrations** in the `migrations/` folder.
- Database name `gtfs-data`, binding `gtfs_data` in `wrangler.jsonc`.

Initialize or apply migrations to the local database:

```sh
yarn wrangler d1 migrations apply gtfs_data --local
```

Inspect tables after loading:

```sh
yarn wrangler d1 execute gtfs_data --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

## R2 GTFS processing

The import process uses an R2 bucket for temporary storage of GTFS files.

- Bucket name `gtfs-processing`, binding `gtfs_processing` in `wrangler.jsonc`.

For local development, Wrangler will automatically use a local R2 bucket. For remote setup:

```sh
yarn wrangler r2 bucket create gtfs-processing
```

## Trigger the Workflows-backed import (uses Cloudflare Workflows) for a specific agency (e.g., `BA` for BART or `CT` for Caltrain):

```sh
yarn wrangler dev
```

```sh
curl "http://127.0.0.1:8787/workflow?id=BA"
```

When using the dev server, you can also trigger cron locally (Cloudflare exposes `/cdn-cgi/handler/scheduled`):

```sh
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"
```

## Remote Setup

Remote creation requires Cloudflare auth (`CLOUDFLARE_API_TOKEN`):

```sh
yarn wrangler d1 create gtfs-data
```

```sh
yarn wrangler d1 migrations apply gtfs_data --remote
```

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command               | Action                                           |
| :-------------------- | :----------------------------------------------- |
| `yarn install`        | Install dependencies (Yarn 4)                    |
| `yarn dev`            | Start the vinext dev server                      |
| `yarn build`          | Production build (vinext) to `./dist/`           |
| `yarn preview`        | Serve the production build locally               |
| `yarn deploy`         | Build and deploy to Cloudflare Workers           |
| `yarn test`           | Run the Vitest suite                             |
| `yarn lint`           | Check formatting with Prettier                   |
| `yarn format`         | Format code with Prettier                        |
| `yarn generate-types` | Regenerate Cloudflare binding types via Wrangler |

## 📚 Docs

- `docs/gtfs-database.md` — database schema and design notes.
- `docs/gtfs-reference.md`, `docs/gtfs-realtime-reference.md` — authoritative
  GTFS specs (do not edit).
- `docs/trmnl-setup.md` — TRMNL e-ink plugin setup.
