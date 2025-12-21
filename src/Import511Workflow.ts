import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { GTFS_FILE_NAMES, importGtfsFeed, type FileKey } from "./importer";

interface Env {
  gtfs_data: D1Database;
  API_KEY_511: string;
  IMPORT_511_WORKFLOW: any;
}

interface Params {
  id: string;
}

export class Import511Workflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
    const { id } = event.payload;

    const zipBuffer = await step.do(
      `Fetch GTFS for agency: ${id}`,
      async () => {
        const response = await fetch(
          `https://api.511.org/transit/datafeeds?api_key=${this.env.API_KEY_511}&operator_id=${id}`,
          {
            headers: {
              Accept: "application/zip",
            },
          },
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`,
          );
        }
        return await response.arrayBuffer();
      },
    );

    await step.do("Import GTFS to D1", async () => {
      // @ts-ignore - JSZip might not have perfect ESM types
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(zipBuffer);

      const fileProvider = async (key: FileKey) => {
        const fileName = GTFS_FILE_NAMES[key];

        // Find the file in the zip, case-insensitive and handling subdirectories
        const file = Object.values(zip.files).find((f) => {
          const name = f.name.toLowerCase();
          return (
            name === fileName.toLowerCase() ||
            name.endsWith("/" + fileName.toLowerCase())
          );
        });

        if (file) {
          return await file.async("string");
        }
        return null;
      };

      await importGtfsFeed(
        this.env,
        {
          sourceName: id,
          versionLabel: `511-${id}-${new Date().toISOString()}`,
          files: fileProvider,
        },
        { clear: true },
      );
    });
  }
}
