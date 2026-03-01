# Live Content Collections

The project uses Astro's experimental live content collections for all dynamic data.

## Key Architectural Decisions

- **Source of Truth**: All collections are defined in `src/live.config.ts` using `defineLiveCollection`.
- **Collections**: agencies, stops, routes, departures, trips, route_stops, trip_stops.
- **Database Access**: Loaders use `import { env } from "cloudflare:workers"` to access the Cloudflare D1 database (`gtfs_data`). The `getDb()` helper returns `db.withSession("first-unconstrained")` for replica reads.
- **Type Safety**: Zod schemas define data shapes; filter interfaces (`StopsFilter`, `RoutesFilter`, `DeparturesFilter`) enforce query parameters.

## Usage in Pages

- Use `getLiveCollection(collection, filter)` and `getLiveEntry(collection, id)` instead of `getCollection` and `getEntry`.
- No need to manually access `Astro.locals.runtime.env` for database operations in `.astro` files; the loaders handle it.
