import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { Import511Workflow } from "./Import511Workflow";

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  return {
    default: {
      fetch: async (request, env, ctx) => {
        // trigger workflow with /workflow?id=agency_id
        const url = new URL(request.url);
        if (url.pathname === "/workflow") {
          const agencyId = url.searchParams.get("id");
          if (agencyId) {
            await env.IMPORT_511_WORKFLOW.create({ params: { id: agencyId } });
            return new Response(`Workflow started for agency id: ${agencyId}`, {
              status: 202,
            });
          } else {
            return new Response("Missing 'id' query parameter", {
              status: 400,
            });
          }
        }

        // @ts-expect-error Request type mismatch because Astro uses the old `cloudflare/workers-types` package
        return handle(manifest, app, request, env, ctx);
      },
      async scheduled(event, _env, _ctx) {
        const scheduledAt = new Date(event.scheduledTime).toISOString();
        console.log(`[cron] Triggered at ${scheduledAt}`);
      },
    } satisfies ExportedHandler<Env>,
    createExports,
    Import511Workflow,
  };
}
