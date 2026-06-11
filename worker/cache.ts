// Edge-cache policy for the worker fetch handler. Kept free of
// "cloudflare:workers" imports so the policy logic is unit-testable.
//
// Pages render realtime delays, but the realtime data itself only updates
// every ~15-60s, so a short shared cache shields D1 from page and bot
// traffic at negligible freshness cost. The Cache API needs a zone: it
// works on the production domain and is a transparent no-op (always miss)
// on workers.dev previews.

// Tunable TTLs.
export const PAGE_TTL_SECONDS = 60;
export const STATIC_TTL_SECONDS = 3600;
// Browsers revalidate quickly so a user refresh picks up new departures.
export const BROWSER_TTL_SECONDS = 15;

export interface CacheRule {
  ttlSeconds: number;
}

// Allowlist; anything not matched here (notably all /api/* routes, which
// TRMNL devices poll for fresh data) bypasses the cache entirely.
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

// Normalized GET request keyed on the full URL (query string matters, e.g.
// the trip page's ?stop= selection).
export function buildCacheKey(request: Request): Request {
  return new Request(request.url, { method: "GET" });
}

export function withCacheHeaders(
  response: Response,
  ttlSeconds: number,
): Response {
  const result = new Response(response.body, response);
  result.headers.set(
    "Cache-Control",
    `public, max-age=${BROWSER_TTL_SECONDS}, s-maxage=${ttlSeconds}`,
  );
  return result;
}
