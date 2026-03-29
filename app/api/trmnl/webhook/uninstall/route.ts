import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    user_uuid?: string;
  };

  if (body.user_uuid) {
    const kv = (env as any).TRMNL_USERS as KVNamespace;
    await kv.delete(`user:${body.user_uuid}`);
  }

  return Response.json({ status: "ok" });
}
