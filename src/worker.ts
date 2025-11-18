import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  return {
    default: {
      fetch: async (request, env, ctx) => {
        // @ts-expect-error Request type mismatch because Astro uses the old `cloudflare/workers-types` package
        return handle(manifest, app, request, env, ctx);
      },
      async scheduled(event, _env, _ctx) {
        const scheduledAt = new Date(event.scheduledTime).toISOString();
        console.log(`[cron] Triggered at ${scheduledAt}`);
      },
    } satisfies ExportedHandler<Env>,
  };
}
