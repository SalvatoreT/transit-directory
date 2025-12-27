# Live Content Collections Refactoring

The project has been refactored to use Astro's experimental live content collections for all dynamic data (`agencies`, `stops`, `departures`).

## Key Architectural Decisions

- **Source of Truth**: All collections are now defined in `src/live.config.ts` using `defineLiveCollection`.
- **Database Access**: Loaders use `import { env } from "cloudflare:workers"` to access the Cloudflare D1 database (`gtfs_data`). This avoids having to pass the database instance through `Astro.locals` in every page.
- **Type Safety**: Proper interfaces for filters (`StopsFilter`, `DeparturesFilter`) and data types (derived from Zod schemas using `z.infer`) are used throughout the loaders to ensure strict type checking.
- **Empty Build-time Collections**: `src/content.config.ts` has an empty `collections` object as all data is now fetched at runtime.

## Usage in Pages

- Use `getLiveCollection(collection, filter)` and `getLiveEntry(collection, id)` instead of `getCollection` and `getEntry`.
- No need to manually access `Astro.locals.runtime.env` for database operations in `.astro` files; the loaders handle it.
