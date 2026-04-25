import handler from "vinext/server/app-router-entry";
import { Import511Workflow } from "../src/Import511Workflow";
import { Import511RealtimeWorkflow } from "../src/Import511RealtimeWorkflow";

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

// Sentinel value for alerts with no end time (year 9999 epoch).
const NO_END_TIME = 253402300799;

// Only the most recent update per trip is ever read (getDepartures/getTripStops
// take MAX(update_pk) per trip_pk), so older rows are dead weight. Keep a small
// window so a trip with no fresh push still shows its last known delay.
async function cleanupTripUpdates(env: Env) {
  const startMs = Date.now();
  const BUDGET_MS = 30000;
  const RETENTION_SECONDS = 2 * 3600;
  const BATCH_SIZE = 50000;

  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  let totalDeleted = 0;
  let batches = 0;

  while (Date.now() - startMs < BUDGET_MS) {
    const result = await env.gtfs_data
      .prepare(
        `DELETE FROM trip_updates
         WHERE update_pk IN (
           SELECT update_pk FROM trip_updates
           WHERE updated_time < ?
           LIMIT ${BATCH_SIZE}
         )`,
      )
      .bind(cutoff)
      .run();

    const deleted = result.meta.changes ?? 0;
    totalDeleted += deleted;
    batches += 1;
    if (deleted < BATCH_SIZE) break;
  }

  console.log(
    `[cleanup] Purged ${totalDeleted} trip_updates rows older than ${RETENTION_SECONDS}s in ${batches} batches.`,
  );
}

async function cleanupServiceAlerts(env: Env) {
  const now = Math.floor(Date.now() / 1000);

  // Auto-close alerts that have been open (sentinel end_time) for over 24 hours
  // based on their start_time. These are likely stale.
  const STALE_THRESHOLD = now - 86400; // 24 hours ago
  const autoCloseResult = await env.gtfs_data
    .prepare(
      `UPDATE service_alerts SET end_time = ?
       WHERE end_time = ? AND start_time IS NOT NULL AND start_time < ?`,
    )
    .bind(now, NO_END_TIME, STALE_THRESHOLD)
    .run();
  console.log(
    `[cleanup] Auto-closed ${autoCloseResult.meta.changes} stale alerts.`,
  );

  // Purge alerts that ended more than 7 days ago.
  const PURGE_CUTOFF = now - 7 * 86400;
  const purgeResult = await env.gtfs_data
    .prepare(
      `DELETE FROM service_alerts
       WHERE alert_pk IN (
         SELECT alert_pk FROM service_alerts
         WHERE end_time < ? AND end_time != ${NO_END_TIME}
         LIMIT 5000
       )`,
    )
    .bind(PURGE_CUTOFF)
    .run();
  console.log(
    `[cleanup] Purged ${purgeResult.meta.changes} expired alerts (ended >7d ago).`,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handler.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(event.scheduledTime).toISOString();
    console.log(`[cron] Triggered at ${scheduledAt}, cron: ${event.cron}`);

    if (event.cron === "0 8 * * *") {
      ctx.waitUntil(triggerStaticFeedUpdates(env));
    } else {
      ctx.waitUntil(triggerRealtimeWorkflow(env));
      // Run cleanup jobs alongside realtime workflow (hourly)
      ctx.waitUntil(cleanupTripUpdates(env));
      ctx.waitUntil(cleanupServiceAlerts(env));
    }
  },
} satisfies ExportedHandler<Env>;

export { Import511Workflow, Import511RealtimeWorkflow };
