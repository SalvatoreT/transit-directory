import { defineConfig } from "astro/config";
import path from "node:path";

import cloudflare from "@astrojs/cloudflare";

const isVitest = Boolean(process.env.VITEST);

// https://astro.build/config
export default defineConfig({
  site: "https://transit.directory",
  experimental: {
    liveContentCollections: true,
  },

  vite: {
    resolve: {
      alias:
        process.env.NODE_ENV === "production"
          ? {}
          : {
              "cloudflare:workers": path.resolve(
                process.cwd(),
                "src/mocks/cloudflare-workers.ts",
              ),
            },
    },
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"],
      },
    },
  },

  adapter: cloudflare({
    imageService: "compile",
    platformProxy: {
      // Vitest never spins up the Astro dev server, so the proxy would linger and hang the process.
      enabled: !isVitest,
    },
    workerEntryPoint: {
      path: "src/worker.ts",
      namedExports: [
        "createExports",
        "Import511Workflow",
        "Import511RealtimeWorkflow",
      ],
    },
  }),
});
