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

    // Allowlisted pages get a short shared TTL.
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
      ctx.waitUntil(triggerStaticFeedUpdates(env));
    }
  },
} satisfies ExportedHandler<Env>;

export { Import511Workflow };
