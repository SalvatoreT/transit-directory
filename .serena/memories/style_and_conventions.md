# Style and Conventions

- Language/typing: TypeScript strict via `astro/tsconfigs/strict`. Astro components `.astro` with TS support. Keep Cloudflare worker types aligned with `worker-configuration.d.ts`.
- Formatting: Prettier with `prettier-plugin-astro`; Astro files use Astro parser; JSONC forbids trailing commas. No explicit lint tool; rely on Prettier and TS/`astro check`. Always run `yarn format` after code changes.
- Package manager: Yarn 4 (Berry). Use `yarn` commands. Avoid `npm`/`pnpm`.
- UI: `Layout.astro` is the HTML shell with Open Graph support. Components use scoped CSS. ASCII-only text.
- Worker: `src/worker.ts` wraps `@astrojs/cloudflare/handler`; keeps `@ts-expect-error` for request type mismatch; includes `scheduled` handler and workflow triggers.
- Data access: Pages use `getLiveCollection` and `getLiveEntry` from Astro's live content collections. Database access is centralized in `src/live.config.ts` loaders.
- Git: Do NOT commit code unless explicitly instructed by the user.
- File naming: `*.astro` for UI components/pages, `.ts` for worker/logic.
