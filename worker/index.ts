import handler from "vinext/server/app-router-entry";
import { Import511Workflow } from "../src/Import511Workflow";
import {
  cacheRuleFor,
  shouldBypassCache,
  withCacheHeaders,
  withPrivateHeaders,
} from "./cache";

// vinext's exported type only declares fetch(request), but at runtime it is
// a full Workers fetch handler that needs env and ctx passed through.
const appFetch = handler.fetch as unknown as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

// Use stable IDs so a second delivery for the same UTC day and source is
// skipped by createBatch. Manual imports can still create independent runs.
async function triggerStaticFeedUpdates(env: Env, scheduledTime: number) {
  const { results: sources } = await env.gtfs_data
    .prepare("SELECT feed_source_id, source_name FROM feed_source")
    .all<{ feed_source_id: number; source_name: string }>();

  const day = new Date(scheduledTime).toISOString().slice(0, 10);
  const batchSize = 100;
  let created = 0;
  const errors: unknown[] = [];
  for (let i = 0; i < sources.length; i += batchSize) {
    const batch = sources.slice(i, i + batchSize).map((source) => ({
      id: `${day}-daily-511-${source.feed_source_id}`,
      params: { id: source.source_name },
    }));
    try {
      const instances = await env.IMPORT_511_WORKFLOW.createBatch(batch);
      created += instances.length;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Daily 511 import dispatch failed");
  }
  console.log(
    `[cron] Created ${created} imports for ${sources.length} sources.`,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const response = await appFetch(request, env, ctx);

    // Workers Caching (wrangler.jsonc `cache.enabled`) serves cached responses
    // before this handler runs and, on a miss, stores whatever we return based
    // on its Cache-Control. We only set those headers here.

    // Requests that must never populate the shared cache: non-GET, cookies,
    // authorization, or RSC negotiation. Mark private even if the framework
    // set a cacheable header.
    if (shouldBypassCache(request)) {
      return withPrivateHeaders(response);
    }

    // Cache directory and live pages according to how their data changes.
    const rule = cacheRuleFor(url.pathname);
    if (rule && response.status === 200) {
      return withCacheHeaders(response, rule.ttlSeconds);
    }

    // /api/* is polled by TRMNL devices for fresh data; keep it uncached.
    if (url.pathname.startsWith("/api/")) {
      return withPrivateHeaders(response);
    }

    // Everything else (static assets, framework chunks) keeps its own headers.
    return response;
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    console.log(`[cron] Triggered at ${scheduledAt}, cron: ${event.cron}`);

    if (event.cron === "0 8 * * *") {
      ctx.waitUntil(triggerStaticFeedUpdates(env, event.scheduledTime));
    }
  },
} satisfies ExportedHandler<Env>;

export { Import511Workflow };
