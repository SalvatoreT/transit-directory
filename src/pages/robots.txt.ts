import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const sitemapURL = site
    ? new URL("sitemap.xml", site).href
    : "https://transit.directory/sitemap.xml";

  return new Response(
    `User-agent: *
Allow: /

Sitemap: ${sitemapURL}
`,
  );
};
