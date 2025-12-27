import { transit_realtime } from "./gtfs-realtime";

export interface RealtimeWorkflowEnv {
  gtfs_data: D1Database;
  API_KEY_511: string;
  IMPORT_REALTIME_WORKFLOW: Workflow;
}

export interface FeedResponse {
  message: transit_realtime.FeedMessage;
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
  return {
    message: transit_realtime.FeedMessage.decode(buffer),
    rateLimitLimit: rateLimitLimit ? parseInt(rateLimitLimit, 10) : null,
    rateLimitRemaining: rateLimitRemaining
      ? parseInt(rateLimitRemaining, 10)
      : null,
  };
}

export async function getFeedContext(
  db: D1Database,
  agencyId: string,
): Promise<{ feedSourceId: number; feedVersionId: number | null }> {
  // 1. Get feed_source_id
  const source = await db
    .prepare("SELECT feed_source_id FROM feed_source WHERE source_name = ?")
    .bind(agencyId)
    .first<{ feed_source_id: number }>();

  if (!source) {
    throw new Error(`Feed source not found for agency: ${agencyId}`);
  }

  // 2. Get active feed_version_id
  const version = await db
    .prepare(
      "SELECT feed_version_id FROM feed_version WHERE feed_source_id = ? AND is_active = 1",
    )
    .bind(source.feed_source_id)
    .first<{ feed_version_id: number }>();

  return {
    feedSourceId: source.feed_source_id,
    feedVersionId: version?.feed_version_id ?? null,
  };
}
