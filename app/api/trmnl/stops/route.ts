import { getAgency, getStops } from "../../../../src/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agency_id");
  if (!agencyId) {
    return Response.json({ error: "Missing agency_id" }, { status: 400 });
  }

  const agency = await getAgency(agencyId);
  if (!agency) {
    return Response.json({ error: "Agency not found" }, { status: 404 });
  }

  const stops = await getStops({
    feed_version_id: agency.feed_version_id,
    is_parent: true,
  });

  const result = stops
    .map((s) => ({ stop_id: s.stop_id, stop_name: s.stop_name }))
    .sort((a, b) => a.stop_name.localeCompare(b.stop_name));

  return Response.json(result);
}
