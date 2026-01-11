import { getLiveCollection } from "astro:content";

export const prerender = false;

export async function GET({ site }: { site: URL }) {
  const { entries: agenciesEntries, error: agenciesError } =
    await getLiveCollection("agencies");

  if (agenciesError) {
    console.error("Error fetching agencies for sitemap:", agenciesError);
    return new Response("Error fetching agencies", { status: 500 });
  }

  const agencies = (agenciesEntries || []).map((entry) => entry.data);
  const baseUrl = site ? site.origin : "https://example.com";

  const agencyUrls = await Promise.all(
    agencies.map(async (agency) => {
      const agencyUrl = `
  <url>
    <loc>${baseUrl}/a/${agency.agency_id}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`;

      // Fetch routes for this agency
      const { entries: routesEntries, error: routesError } =
        await getLiveCollection("routes", {
          feed_version_id: agency.feed_version_id,
          agency_pk: agency.agency_pk,
        });

      if (routesError) {
        console.error(
          `Error fetching routes for agency ${agency.agency_id}:`,
          routesError,
        );
        return agencyUrl; // Return just the agency URL if routes fail
      }

      const routes = (routesEntries || []).map((entry) => entry.data);
      const routeUrls = routes
        .map(
          (route) => `
  <url>
    <loc>${baseUrl}/a/${agency.agency_id}/r/${route.route_id}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`,
        )
        .join("");

      return agencyUrl + routeUrls;
    }),
  );

  // Generate XML
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  ${agencyUrls.join("")}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
