import { getTrmnlData } from "../../../../../src/lib/trmnl/data";
import { renderLayout } from "../../../../../src/lib/trmnl/render";

export const dynamic = "force-dynamic";

const VALID_LAYOUTS = new Set([
  "full",
  "half_horizontal",
  "half_vertical",
  "quadrant",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ layout: string }> },
) {
  const { layout } = await params;

  if (!VALID_LAYOUTS.has(layout)) {
    return new Response(
      `Unknown layout "${layout}". Valid: full, half_horizontal, half_vertical, quadrant`,
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agency_id") || "";
  const stopId = url.searchParams.get("stop_id") || "";

  if (!agencyId || !stopId) {
    return new Response("Missing required query params: agency_id, stop_id", {
      status: 400,
    });
  }

  const data = await getTrmnlData(agencyId, stopId);
  const html = renderLayout(layout, data);

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
