# Style and Conventions

- Language/typing: TypeScript strict via `astro/tsconfigs/strict`. Astro components `.astro` with TS support. Keep Cloudflare worker types aligned with `worker-configuration.d.ts`.
- Formatting: Prettier with `prettier-plugin-astro`; Astro files use Astro parser; JSONC forbids trailing commas. No explicit lint tool; rely on Prettier and TS/`astro check`.
- Package manager: Yarn 4 (Berry). Use `yarn` commands; PnP by default (though `node_modules/` may exist locally). Avoid `npm`/`pnpm`.
- UI defaults: `Layout.astro` minimal HTML shell. `Welcome.astro` uses Inter/Roboto stack and blurred background image; styles are inline in component.
- Worker: `src/worker.ts` wraps `@astrojs/cloudflare/handler`; keeps `@ts-expect-error` for request type mismatch; includes `scheduled` handler that logs cron time.
- Git: Do NOT commit code unless explicitly instructed by the user.
