import { getTrmnlData } from "../../../../src/lib/trmnl/data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agency_id") || "";
  const stopId = url.searchParams.get("stop_id") || "";

  if (!agencyId || !stopId) {
    return Response.json(
      { error: "Missing required query params: agency_id, stop_id" },
      { status: 400 },
    );
  }

  const data = await getTrmnlData(agencyId, stopId);
  return Response.json(data);
}
