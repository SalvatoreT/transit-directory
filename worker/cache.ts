// Edge-cache policy for the worker fetch handler. Kept free of
// "cloudflare:workers" imports so the policy logic is unit-testable.
//
// The worker relies on Workers Caching (wrangler.jsonc `cache.enabled`): the
// runtime checks its cache before invoking the worker and, on a miss, stores
// any response whose Cache-Control marks it cacheable. Instead of driving the
// Cache API by hand we express intent through headers here.
// See https://developers.cloudflare.com/workers/cache/.
//
// Pages render realtime delays, but the realtime data itself only updates
// every ~15-60s, so a short shared cache shields D1 from page and bot traffic
// at negligible freshness cost.

// Tunable TTLs.
export const PAGE_TTL_SECONDS = 60;
export const STATIC_TTL_SECONDS = 3600;
// Browsers revalidate quickly so a user refresh picks up new departures.
export const BROWSER_TTL_SECONDS = 15;

export interface CacheRule {
  ttlSeconds: number;
}

// Allowlist; anything not matched here (notably all /api/* routes, which
// TRMNL devices poll for fresh data) is served uncached.
export function cacheRuleFor(pathname: string): CacheRule | null {
  if (pathname === "/") return { ttlSeconds: PAGE_TTL_SECONDS };
  if (pathname === "/sitemap.xml" || pathname === "/robots.txt") {
    return { ttlSeconds: STATIC_TTL_SECONDS };
  }
  if (pathname.startsWith("/a/")) return { ttlSeconds: PAGE_TTL_SECONDS };
  return null;
}

// Headers used by React Server Component / Next router negotiation; those
// responses must never be cached under the page's HTML URL.
const RSC_NEGOTIATION_HEADERS = [
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
];

export function shouldBypassCache(request: Request): boolean {
  if (request.method !== "GET") return true;
  if (request.headers.has("cookie") || request.headers.has("authorization")) {
    return true;
  }
  for (const header of RSC_NEGOTIATION_HEADERS) {
    if (request.headers.has(header)) return true;
  }
  return false;
}

// Merge additional field names into an existing Vary header without dropping
// what the framework already set (e.g. Accept-Encoding) or duplicating names.
function appendVary(headers: Headers, fields: string[]): void {
  const existing = (headers.get("Vary") || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const seen = new Set(existing.map((f) => f.toLowerCase()));
  for (const field of fields) {
    if (!seen.has(field.toLowerCase())) {
      existing.push(field);
      seen.add(field.toLowerCase());
    }
  }
  headers.set("Vary", existing.join(", "));
}

// Mark a response cacheable in the shared edge cache for `ttlSeconds`. Varying
// on the RSC negotiation headers keeps a cached HTML page from ever being
// served in place of a flight payload for the same URL.
export function withCacheHeaders(
  response: Response,
  ttlSeconds: number,
): Response {
  const result = new Response(response.body, response);
  result.headers.set(
    "Cache-Control",
    `public, max-age=${BROWSER_TTL_SECONDS}, s-maxage=${ttlSeconds}`,
  );
  appendVary(result.headers, RSC_NEGOTIATION_HEADERS);
  return result;
}

// Keep a response out of the shared edge cache. Used for RSC/authenticated
// requests and for always-fresh routes like /api/* so Workers Caching never
// stores them even if the framework set a cacheable header.
export function withPrivateHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}
