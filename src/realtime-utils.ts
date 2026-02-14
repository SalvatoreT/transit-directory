import { transit_realtime } from "./gtfs-realtime";

export interface RealtimeWorkflowEnv {
  gtfs_data: D1Database;
  API_KEY_511: string;
  IMPORT_REALTIME_WORKFLOW: Workflow;
}

export interface FeedResponse {
  message: transit_realtime.IFeedMessage;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
}

export async function fetchAndDecodeFeed(url: string): Promise<FeedResponse> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch feed from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const rateLimitLimit = response.headers.get("RateLimit-Limit");
  const rateLimitRemaining = response.headers.get("RateLimit-Remaining");

  const arrayBuffer = await response.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  try {
    return {
      message: transit_realtime.FeedMessage.decode(buffer),
      rateLimitLimit: rateLimitLimit ? parseInt(rateLimitLimit, 10) : null,
      rateLimitRemaining: rateLimitRemaining
        ? parseInt(rateLimitRemaining, 10)
        : null,
    };
  } catch (err) {
    console.error(`Error decoding GTFS-Realtime feed from ${url}:`, err);
    throw err;
  }
}
