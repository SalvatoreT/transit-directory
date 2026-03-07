# Repository Guidelines

## Startup

- **IMPORTANT**: Always activate the Serena MCP server at the start of every session. Use the `serena_activate_project` tool with `project_dir` set to `.` before doing any work.

## Project Structure & Module Organization

- App Router pages live in `app/` using Next.js conventions (`page.tsx`, `layout.tsx`).
- Source utilities and components live in `src/`: data access (`src/db.ts`), components (`src/components/`), assets (`src/assets/`).
- Worker entry for scheduled/workflow exports is `worker/index.ts`.
- Tests go in `test/` and Vitest config in `vitest.config.ts`.
- Build output is `dist/`; configuration lives at `vite.config.ts`, `tsconfig.json`, `.prettierrc`, and `wrangler.jsonc`.
- GTFS schema/design notes are in `docs/gtfs-database.md`; `docs/gtfs-reference.md` is authoritative from GTFS (do not edit).
- GTFS schema managed via migrations in the `migrations/` directory.
- Workflows binding `IMPORT_511_WORKFLOW` triggers `Import511Workflow` (in `src/Import511Workflow.ts`) which fetches and imports GTFS data from 511.org.

## Build, Test, and Development Commands

- `yarn install` — install dependencies (Yarn 4).
- `yarn dev` — run vinext dev server.
- `yarn build` — production build via vinext.
- `yarn preview` — serve the built site locally.
- `yarn deploy` — build and deploy to Cloudflare Workers.
- `yarn test` — run Vitest suite (`vitest run`).
- `yarn lint` — check formatting with Prettier.
- `yarn format` — format code with Prettier.
- `yarn generate-types` — regenerate Cloudflare worker types via Wrangler.
- `yarn wrangler d1 migrations apply gtfs_data --local` — apply local D1 migrations.
- `yarn wrangler d1 execute gtfs_data --local --command "<SQL COMMAND>"` — run arbitrary SQL against local D1.

## Coding Style & Naming Conventions

- TypeScript strict mode; favor explicit types when uncertain.
- React Server Components by default; use `"use client"` only for components needing browser APIs.
- CSS Modules for component styling (`.module.css` files).
- Formatting: Prettier. JSONC uses no trailing commas.
- **IMPORTANT**: Always run `yarn format` when you're done making code changes.
- **IMPORTANT**: Always run `yarn lint` before completing any change to verify there are no formatting issues.
- Use ASCII-only text.
- Name files by role (`.tsx` for React components, `.ts` for worker/logic).

## Testing Guidelines

- Framework: Vitest. Place tests alongside sources or under `test/`.
- Use clear, deterministic tests; prefer `describe/it` naming that mirrors feature or component names.
- Run `yarn test` before proposing changes; add cases for new behavior and regressions.

## Commit & Pull Request Guidelines

- **IMPORTANT**: Do NOT commit code unless explicitly instructed to do so by the user.
- Commit messages: short, imperative summaries (e.g., "add GTFS schema notes", "fix worker cron logging").
- Pull requests: describe the change, link issues/tasks, note testing (`yarn test`, `yarn build` when relevant), and include screenshots for UI changes if applicable.

## Security & Configuration Tips

- Worker entry is `worker/index.ts` for scheduled handlers and workflow exports.
- Cloudflare bindings accessed via `import { env } from "cloudflare:workers"` in server components.
- Regenerate types with `yarn generate-types` when Cloudflare bindings change.
- Do not commit local `.wrangler` secrets or environment-specific files; prefer configuration via Cloudflare env vars.
- D1 binding is `gtfs_data` (database `gtfs-data`).
