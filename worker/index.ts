import handler from "vinext/server/app-router-entry";
import { Import511Workflow } from "../src/Import511Workflow";
import {
  buildCacheKey,
  cacheRuleFor,
  shouldBypassCache,
  withCacheHeaders,
} from "./cache";

// vinext's exported type only declares fetch(request), but at runtime it is
// a full Workers fetch handler that needs env and ctx passed through.
const appFetch = handler.fetch as unknown as (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

// Workflow instance ids are padded to the maximum length so concurrent
// triggers can never collide.
function makeWorkflowInstanceId(prefix: string): string {
  const maxLen = 64;
  const remaining = Math.max(0, maxLen - prefix.length);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let randomStr = "";
  for (let i = 0; i < remaining; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return prefix + randomStr;
}

const pad = (n: number) => n.toString().padStart(2, "0");

async function triggerStaticFeedUpdates(env: Env) {
  const result = await env.gtfs_data
    .prepare("SELECT source_name FROM feed_source")
    .all<{ source_name: string }>();

  const agencies = result.results || [];

  if (agencies.length === 0) {
    console.log("[cron] No feed sources found, skipping static feed updates.");
    return;
  }

  console.log(
    `[cron] Triggering static feed updates for ${agencies.length} agencies.`,
  );

  const now = new Date();
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  for (const agency of agencies) {
    const operatorId = agency.source_name;

    try {
      await env.IMPORT_511_WORKFLOW.create({
        id: makeWorkflowInstanceId(`${yyyymmdd}-daily-511-${operatorId}-`),
        params: { id: operatorId },
      });
      console.log(`[cron] Triggered static feed update for ${operatorId}.`);
    } catch (err) {
      console.error(
        `[cron] Failed to trigger static feed update for ${operatorId}:`,
        err,
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const rule = cacheRuleFor(url.pathname);
    if (!rule || shouldBypassCache(request)) {
      return appFetch(request, env, ctx);
    }

    // Workers' CacheStorage has .default; lib.dom's typing shadows it here.
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = buildCacheKey(request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set("x-cache", "HIT");
      return response;
    }

    const response = await appFetch(request, env, ctx);
    if (response.status !== 200) {
      return response;
    }

    const cacheable = withCacheHeaders(response, rule.ttlSeconds);
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    cacheable.headers.set("x-cache", "MISS");
    return cacheable;
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    console.log(`[cron] Triggered at ${scheduledAt}, cron: ${event.cron}`);

    if (event.cron === "0 8 * * *") {
      ctx.waitUntil(triggerStaticFeedUpdates(env));
    }
  },
} satisfies ExportedHandler<Env>;

export { Import511Workflow };
