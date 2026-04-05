import { env } from "cloudflare:workers";
import {
  getTrmnlData,
  type TrmnlUserConfig,
} from "../../../../src/lib/trmnl/data";
import { renderLayout, SCREEN_X } from "../../../../src/lib/trmnl/render";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData();
  const userUuid = form.get("user_uuid") as string | null;

  let agencyId = "";
  let stopId = "";
  let displayName = "";

  if (userUuid) {
    const kv = (env as any).TRMNL_USERS as KVNamespace;
    const raw = await kv.get(`user:${userUuid}`);
    if (raw) {
      const config: TrmnlUserConfig = JSON.parse(raw);
      agencyId = config.agency_id;
      stopId = config.stop_id;
      displayName = config.display_name;
    }
  }

  if (!agencyId || !stopId) {
    const emptyData = {
      stopName: displayName || "Transit",
      stopId: "",
      agencyName: "",
      departures: [],
      departureCount: 0,
      lastUpdated: new Date().toISOString(),
    };
    return Response.json({
      markup: renderLayout("full", emptyData),
      markup_half_horizontal: renderLayout("half_horizontal", emptyData),
      markup_half_vertical: renderLayout("half_vertical", emptyData),
      markup_quadrant: renderLayout("quadrant", emptyData),
      markup_x: renderLayout("full", emptyData, SCREEN_X),
      markup_x_half_horizontal: renderLayout(
        "half_horizontal",
        emptyData,
        SCREEN_X,
      ),
      markup_x_half_vertical: renderLayout(
        "half_vertical",
        emptyData,
        SCREEN_X,
      ),
      markup_x_quadrant: renderLayout("quadrant", emptyData, SCREEN_X),
    });
  }

  const data = await getTrmnlData(agencyId, stopId, displayName || undefined);

  return Response.json({
    markup: renderLayout("full", data),
    markup_half_horizontal: renderLayout("half_horizontal", data),
    markup_half_vertical: renderLayout("half_vertical", data),
    markup_quadrant: renderLayout("quadrant", data),
    markup_x: renderLayout("full", data, SCREEN_X),
    markup_x_half_horizontal: renderLayout("half_horizontal", data, SCREEN_X),
    markup_x_half_vertical: renderLayout("half_vertical", data, SCREEN_X),
    markup_x_quadrant: renderLayout("quadrant", data, SCREEN_X),
  });
}
