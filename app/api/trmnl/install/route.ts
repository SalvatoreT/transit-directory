import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const callbackUrl = url.searchParams.get("installation_callback_url");

  if (!code || !callbackUrl) {
    return new Response("Missing code or callback URL", { status: 400 });
  }

  const clientId = (env as any).TRMNL_CLIENT_ID as string;
  const clientSecret = (env as any).TRMNL_CLIENT_SECRET as string;

  const tokenRes = await fetch("https://trmnl.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    return new Response(`OAuth token exchange failed: ${tokenRes.status}`, {
      status: 500,
    });
  }

  const { access_token } = (await tokenRes.json()) as {
    access_token: string;
  };

  const kv = (env as any).TRMNL_USERS as KVNamespace;
  await kv.put(`pending:${access_token}`, JSON.stringify({ access_token }), {
    expirationTtl: 600,
  });

  return Response.redirect(callbackUrl);
}
