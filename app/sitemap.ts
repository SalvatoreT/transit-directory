import type { MetadataRoute } from "next";
import { getSitemapRoutes } from "../src/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://transit.directory";
  const rows = await getSitemapRoutes();

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      changeFrequency: "daily",
      priority: 1.0,
    },
  ];

  let lastAgencyPk: number | undefined;
  for (const row of rows) {
    const agencyUrl = `${baseUrl}/a/${row.agency_id}`;
    if (row.agency_pk !== lastAgencyPk) {
      entries.push({ url: agencyUrl, changeFrequency: "daily", priority: 0.8 });
      lastAgencyPk = row.agency_pk;
    }
    if (row.route_id !== null) {
      entries.push({
        url: `${agencyUrl}/r/${row.route_id}`,
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
  }

  return entries;
}
