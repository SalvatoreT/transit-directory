# Style and Conventions

- Language/typing: TypeScript strict. React Server Components by default; `"use client"` only for components needing browser APIs. Keep Cloudflare worker types aligned with `worker-configuration.d.ts` (`yarn generate-types`).
- Formatting: Prettier (no Astro plugin; the project is Next.js via vinext). JSONC forbids trailing commas. No separate linter; `yarn lint` runs `prettier --check`. Always run `yarn format` after code changes.
- Package manager: Yarn 4 (Berry). Use `yarn` commands. Avoid `npm`/`pnpm`.
- UI: `app/layout.tsx` is the HTML shell. CSS Modules (`.module.css`) for component styling. ASCII-only text.
- Worker: `worker/index.ts` wraps vinext's `app-router-entry` handler; includes the edge-cache middleware, `scheduled` handler, and workflow class exports.
- Data access: pages import query helpers from `src/db.ts`; pure SQL builders/constants live in `src/db-queries.ts` and `src/cleanup-queries.ts` (kept free of `cloudflare:workers` imports so vitest can load them).
- Workflow code conventions: every wall-clock read (`Date.now()`) happens inside `step.do` and is returned in the step result; run()-scope state must be reconstructible from persisted step results (replay safety).
- Git: Do NOT commit code unless explicitly instructed by the user. Squash to one commit per PR.
- File naming: `.tsx` for React components/pages, `.ts` for worker/logic.
