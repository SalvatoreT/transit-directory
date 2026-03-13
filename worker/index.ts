import handler from "vinext/server/app-router-entry";
import { Import511Workflow } from "../src/Import511Workflow";
import { Import511RealtimeWorkflow } from "../src/Import511RealtimeWorkflow";
import {
  getSessionId,
  generateSessionId,
  sessionCookieHeader,
  verifyToken,
  renderChallengePage,
} from "../src/turnstile";

async function triggerRealtimeWorkflow(env: Env) {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const prefix = `${yyyymmdd}-${hhmmss}-511-RG-`;

  const maxLen = 64;
  const remaining = Math.max(0, maxLen - prefix.length);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let randomStr = "";
  for (let i = 0; i < remaining; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  await env.IMPORT_REALTIME_WORKFLOW.create({
    id: prefix + randomStr,
    params: {
      agencyId: "RG",
    },
  });
  console.log("Triggered regional realtime workflow (agency=RG).");
}

async function triggerStaticFeedUpdates(env: Env) {
  const result = await env.gtfs_data
    .prepare("SELECT source_name FROM feed_source")
    .all<{ source_name: string }>();

  const agencies = result.results || [];

  if (agencies.length === 0) {
    console.log("[cron] No feed sources found, skipping static feed updates.");
    return;
  }

  console.log(
    `[cron] Triggering static feed updates for ${agencies.length} agencies.`,
  );

  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyymmdd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  for (const agency of agencies) {
    const operatorId = agency.source_name;
    const prefix = `${yyyymmdd}-daily-511-${operatorId}-`;
    const maxLen = 64;
    const remaining = Math.max(0, maxLen - prefix.length);
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let randomStr = "";
    for (let i = 0; i < remaining; i++) {
      randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    try {
      await env.IMPORT_511_WORKFLOW.create({
        id: prefix + randomStr,
        params: { id: operatorId },
      });
      console.log(`[cron] Triggered static feed update for ${operatorId}.`);
    } catch (err) {
      console.error(
        `[cron] Failed to trigger static feed update for ${operatorId}:`,
        err,
      );
    }
  }
}

async function handleTurnstile(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  // Let robots.txt and sitemap.xml through for SEO crawlers
  if (url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") {
    return null;
  }

  // Handle the verification POST
  if (request.method === "POST" && url.pathname === "/__turnstile-verify") {
    const formData = await request.formData();
    const token = formData.get("cf-turnstile-response") as string;
    const redirect = (formData.get("redirect") as string) || "/";
    const ip = request.headers.get("CF-Connecting-IP") || "";

    if (!token || !(await verifyToken(token, env.TURNSTILE_SECRET_KEY, ip))) {
      return new Response(
        renderChallengePage(env.TURNSTILE_SITE_KEY, redirect),
        {
          status: 403,
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        },
      );
    }

    const sessionId = generateSessionId();
    await env.SESSION.put(sessionId, "1", { expirationTtl: 86400 });

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirect,
        "Set-Cookie": sessionCookieHeader(sessionId),
      },
    });
  }

  // Check for an existing valid session
  const sessionId = getSessionId(request);
  if (sessionId) {
    const value = await env.SESSION.get(sessionId);
    if (value !== null) {
      return null; // Valid session, proceed to app
    }
  }

  // No valid session -- show challenge page
  const redirectUrl = url.pathname + url.search;
  return new Response(
    renderChallengePage(env.TURNSTILE_SITE_KEY, redirectUrl),
    {
      status: 403,
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const turnstileResponse = await handleTurnstile(request, env);
    if (turnstileResponse) {
      return turnstileResponse;
    }
    return handler.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    console.log(`[cron] Triggered at ${scheduledAt}, cron: ${event.cron}`);

    if (event.cron === "0 8 * * *") {
      ctx.waitUntil(triggerStaticFeedUpdates(env));
    } else {
      ctx.waitUntil(triggerRealtimeWorkflow(env));
    }
  },
} satisfies ExportedHandler<Env>;

export { Import511Workflow, Import511RealtimeWorkflow };
