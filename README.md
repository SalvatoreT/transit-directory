# Transit Directory

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

Trigger the Workflows-backed import (uses Cloudflare Workflows) for a specific agency (e.g., `BA` for BART or `CT` for Caltrain):

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

| Command                | Action                                           |
| :--------------------- | :----------------------------------------------- |
| `yarn install`         | Installs dependencies                            |
| `yarn dev`             | Starts local dev server at `localhost:4321`      |
| `yarn build`           | Build your production site to `./dist/`          |
| `yarn preview`         | Preview your build locally, before deploying     |
| `yarn astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `yarn astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
