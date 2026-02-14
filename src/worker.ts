import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { Import511Workflow } from "./Import511Workflow";
import { Import511RealtimeWorkflow } from "./Import511RealtimeWorkflow";

async function triggerRealtimeWorkflow(env: Env) {
  // Use the Regional feed (agency=RG) which includes all agencies in a single response.
  // This reduces API calls from ~72/cycle to 2/cycle (TripUpdates + ServiceAlerts).
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const prefix = `${yyyymmdd}-${hhmmss}-511-RG-`;

  const maxLen = 64;
  const remaining = Math.max(0, maxLen - prefix.length);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let randomStr = "";
  for (let i = 0; i < remaining; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  await env.IMPORT_REALTIME_WORKFLOW.create({
    id: prefix + randomStr,
    params: {
      agencyId: "RG",
    },
  });
  console.log("Triggered regional realtime workflow (agency=RG).");
}

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  return {
    default: {
      fetch: async (request, env, ctx) => {
        // trigger workflow with /workflow?id=agency_id
        const url = new URL(request.url);
        if (url.pathname === "/workflow") {
          if (!import.meta.env.DEV) {
            return new Response("Not Found", { status: 404 });
          }
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          const agencyId = url.searchParams.get("id");
          if (agencyId) {
            const instance = await env.IMPORT_511_WORKFLOW.create({
              params: { id: agencyId },
            });
            console.log("Workflow instance created:", instance);
            return new Response(`Workflow started for agency id: ${agencyId}`, {
              status: 202,
            });
          } else {
            return new Response("Missing 'id' query parameter", {
              status: 400,
            });
          }
        }

        if (url.pathname === "/realtime-workflow") {
          if (!import.meta.env.DEV) {
            return new Response("Not Found", { status: 404 });
          }
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405 });
          }
          await triggerRealtimeWorkflow(env);
          return new Response(`Realtime Workflow started`, {
            status: 202,
          });
        }

        const cacheUrl = new URL(request.url);
        const cacheKey = new Request(cacheUrl.toString(), request);
        // @ts-expect-error TypeScript has issues finding the `default`
        const cache = caches.default as Cache;
        let response = await cache.match(cacheKey);

        if (!response) {
          response = await handle(manifest, app, request, env as any, ctx);
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
      },
      async scheduled(event, env, ctx) {
        const scheduledAt = new Date(event.scheduledTime).toISOString();
        console.log(`[cron] Triggered at ${scheduledAt}`);

        ctx.waitUntil(triggerRealtimeWorkflow(env));
      },
    } satisfies ExportedHandler<Env>,
    createExports,
    Import511Workflow,
    Import511RealtimeWorkflow,
  };
}
