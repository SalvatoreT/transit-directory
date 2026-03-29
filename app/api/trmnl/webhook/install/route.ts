import { env } from "cloudflare:workers";
import type { TrmnlUserConfig } from "../../../../../src/lib/trmnl/data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = request.headers.get("Authorization");
  const accessToken = auth?.replace("Bearer ", "") || "";

  const body = (await request.json()) as {
    user_uuid: string;
    plugin_setting_id?: string;
  };

  const config: TrmnlUserConfig = {
    agency_id: "",
    stop_id: "",
    display_name: "My Stop",
    access_token: accessToken,
    plugin_setting_id: body.plugin_setting_id,
  };

  const kv = (env as any).TRMNL_USERS as KVNamespace;
  await kv.put(`user:${body.user_uuid}`, JSON.stringify(config));
  await kv.delete(`pending:${accessToken}`);

  return Response.json({ status: "ok" });
}
