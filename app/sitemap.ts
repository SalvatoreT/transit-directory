import type { MetadataRoute } from "next";
import { getAgencies, getRoutes } from "../src/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://transit.directory";
  const agencies = await getAgencies();

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/`,
      changeFrequency: "daily",
      priority: 1.0,
    },
  ];

  for (const agency of agencies) {
    entries.push({
      url: `${baseUrl}/a/${agency.agency_id}`,
      changeFrequency: "daily",
      priority: 0.8,
    });

    const routes = await getRoutes({
      feed_version_id: agency.feed_version_id,
      agency_pk: agency.agency_pk,
    });

    for (const route of routes) {
      entries.push({
        url: `${baseUrl}/a/${agency.agency_id}/r/${route.route_id}`,
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
  }

  return entries;
}
