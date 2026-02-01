# Repository Guidelines

## Project Structure & Module Organization

- Source lives in `src/`: pages (`src/pages/index.astro`), shared layout (`src/layouts/Layout.astro`), worker entry (`src/worker.ts`), assets (`src/assets/`), and static files under `public/`.
- Tests go in `test/` and Vitest config in `vitest.config.ts`.
- Build output is `dist/`; configuration lives at `astro.config.ts`, `tsconfig.json`, `.prettierrc`, and `wrangler.jsonc`.
- GTFS schema/design notes are in `docs/gtfs-database.md`; `docs/gtfs-reference.md` is authoritative from GTFS (do not edit).
- GTFS schema managed via migrations in the `migrations/` directory.
- Workflows binding `IMPORT_511_WORKFLOW` triggers `Import511Workflow` (in `src/Import511Workflow.ts`) which fetches and imports GTFS data from 511.org.

## Build, Test, and Development Commands

- `yarn install` — install dependencies (Yarn 4).
- `yarn dev` — run Astro dev server (defaults to http://localhost:4321).
- `yarn build` — production build to `dist/` using the Cloudflare adapter.
- `yarn preview` — serve the built site locally.
- `yarn test` — run Vitest suite (`vitest run`).
- `yarn lint` — check formatting with Prettier.
- `yarn format` — format code with Prettier.
- `yarn astro check` — Astro/TypeScript diagnostics.
- `yarn generate-types` — regenerate Cloudflare worker types via Wrangler.
- `yarn wrangler d1 migrations apply gtfs_data --local` — apply local D1 migrations.
- `yarn wrangler d1 execute gtfs_data --local --command "<SQL COMMAND>"` — run arbitrary SQL against local D1.
- `curl http://127.0.0.1:8788/workflow?id=<operator_id>` — trigger GTFS import for a specific agency via the `Import511Workflow`.
- `curl "http://127.0.0.1:8788/cdn-cgi/handler/scheduled"` — trigger cron locally while dev server is running.

## Coding Style & Naming Conventions

- TypeScript strict via `astro/tsconfigs/strict`; favor explicit types when uncertain.
- Formatting: Prettier with `prettier-plugin-astro`; run `yarn prettier --write <paths>` before committing. JSONC uses no trailing commas.
- Astro components co-locate CSS; keep styles minimal and scoped. Use ASCII-only text.
- Name files by role (`*.astro` for UI, `.ts` for worker/logic).

## Testing Guidelines

- Framework: Vitest. Place tests alongside sources or under `test/`.
- Use clear, deterministic tests; prefer `describe/it` naming that mirrors feature or component names.
- Run `yarn test` before proposing changes; add cases for new behavior and regressions.

## Commit & Pull Request Guidelines

- **IMPORTANT**: Do NOT commit code unless explicitly instructed to do so by the user.
- Commit messages: short, imperative summaries (e.g., “add GTFS schema notes”, “fix worker cron logging”).
- Pull requests: describe the change, link issues/tasks, note testing (`yarn test`, `yarn astro check`, `yarn build` when relevant), and include screenshots for UI changes if applicable.

## Security & Configuration Tips

- Worker entry is `src/worker.ts`; keep `@ts-expect-error` for Cloudflare request typing unless types are updated.
- Regenerate types with `yarn generate-types` when Cloudflare bindings change.
- Do not commit local `.wrangler` secrets or environment-specific files; prefer configuration via Cloudflare env vars.
- D1 binding is `gtfs_data` (database `gtfs-data`). The `/workflow` route triggers a GTFS import for the provided `id`.
