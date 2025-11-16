// @ts-check
import {defineConfig} from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

const isVitest = Boolean(process.env.VITEST);

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({
    imageService: "compile",
    platformProxy: {
      // Vitest never spins up the Astro dev server, so the proxy would linger and hang the process.
      enabled: !isVitest,
    },
  })
});
