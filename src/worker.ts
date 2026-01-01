import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { Import511Workflow } from "./Import511Workflow";
import { Import511RealtimeWorkflow } from "./Import511RealtimeWorkflow";

async function triggerRealtimeWorkflow(env: Env) {
  const { results } = await env.gtfs_data
    .prepare("SELECT source_name FROM feed_source")
    .all<{ source_name: string }>();

  const agencies = results.map((r) => r.source_name);
  if (agencies.length === 0) {
    console.log("No agencies found.");
    return;
  }

  // 60 requests/hour limit shared.
  // Each iteration does 2 requests.
  // Sleep time between requests = 60 * N.
  const waitTimeSeconds = Math.max(60, agencies.length * 60);

  const batch = agencies.map((id) => {
    // ID Format: YYYYMMDD-HHMMSS-511-<agency_id>-<remaining_random-characters>
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const prefix = `${yyyymmdd}-${hhmmss}-511-${id}-`;

    // Workflow instance IDs must be <= 64 characters
    const maxLen = 64;
    const remaining = Math.max(0, maxLen - prefix.length);
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let randomStr = "";
    for (let i = 0; i < remaining; i++) {
      randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return {
      id: prefix + randomStr,
      params: {
        agencyId: id,
        waitTimeSeconds,
      },
    };
  });

  await env.IMPORT_REALTIME_WORKFLOW.createBatch(batch);
  console.log(`Triggered realtime workflow for ${agencies.length} agencies.`);
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

        // @ts-expect-error Request type mismatch because Astro uses the old `cloudflare/workers-types` package
        return handle(manifest, app, request, env, ctx);
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
