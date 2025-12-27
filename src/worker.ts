import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { Import511Workflow } from "./Import511Workflow";
import { ImportTripUpdatesWorkflow } from "./ImportTripUpdatesWorkflow";
import { ImportVehiclePositionsWorkflow } from "./ImportVehiclePositionsWorkflow";
import { ImportServiceAlertsWorkflow } from "./ImportServiceAlertsWorkflow";

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  return {
    default: {
      fetch: async (request, env, ctx) => {
        // trigger workflow with /workflow?id=agency_id
        const url = new URL(request.url);
        if (url.pathname === "/workflow") {
          const agencyId = url.searchParams.get("id");
          if (agencyId) {
            await env.IMPORT_511_WORKFLOW.create({ params: { id: agencyId } });
            return new Response(`Workflow started for agency id: ${agencyId}`, {
              status: 202,
            });
          } else {
            return new Response("Missing 'id' query parameter", {
              status: 400,
            });
          }
        }

        if (url.pathname === "/realtime-workflow") {
          const agencyId = url.searchParams.get("agency");
          const feedType = url.searchParams.get("feedType");

          if (agencyId && feedType) {
            if (feedType === "tripupdates") {
              await env.IMPORT_TRIP_UPDATES_WORKFLOW.create({
                params: { agency: agencyId },
              });
            } else if (feedType === "vehiclepositions") {
              await env.IMPORT_VEHICLE_POSITIONS_WORKFLOW.create({
                params: { agency: agencyId },
              });
            } else if (feedType === "servicealerts") {
              await env.IMPORT_SERVICE_ALERTS_WORKFLOW.create({
                params: { agency: agencyId },
              });
            } else {
              return new Response(
                "Invalid 'feedType'. Must be one of: tripupdates, vehiclepositions, servicealerts",
                { status: 400 },
              );
            }

            return new Response(
              `Realtime Workflow started for agency: ${agencyId}, feed: ${feedType}`,
              {
                status: 202,
              },
            );
          } else {
            return new Response(
              "Missing 'agency' or 'feedType' query parameters",
              {
                status: 400,
              },
            );
          }
        }

        // @ts-expect-error Request type mismatch because Astro uses the old `cloudflare/workers-types` package
        return handle(manifest, app, request, env, ctx);
      },
      async scheduled(event, env, ctx) {
        const scheduledAt = new Date(event.scheduledTime).toISOString();
        console.log(`[cron] Triggered at ${scheduledAt}`);

        // ctx.waitUntil(
        //   (async () => {
        //     const { results } = await env.gtfs_data
        //       .prepare("SELECT source_name FROM feed_source")
        //       .all<{ source_name: string }>();
        //
        //     if (!results || results.length === 0) return;
        //
        //     const agencies = results.map((r) => r.source_name);
        //
        //     // Create 4 sets of parameters with 15s delay increments (0, 15, 30, 45)
        //     const allWorkflowParams = [0, 15, 30, 45].flatMap((delay) =>
        //       agencies.map((agency) => ({
        //         params: { agency, delayStart: delay },
        //       })),
        //     );
        //
        //     await Promise.all([
        //       env.IMPORT_TRIP_UPDATES_WORKFLOW.createBatch(allWorkflowParams),
        //       env.IMPORT_VEHICLE_POSITIONS_WORKFLOW.createBatch(
        //         allWorkflowParams,
        //       ),
        //       env.IMPORT_SERVICE_ALERTS_WORKFLOW.createBatch(allWorkflowParams),
        //     ]);
        //   })(),
        // );
      },
    } satisfies ExportedHandler<Env>,
    createExports,
    Import511Workflow,
    ImportTripUpdatesWorkflow,
    ImportVehiclePositionsWorkflow,
    ImportServiceAlertsWorkflow,
  };
}
