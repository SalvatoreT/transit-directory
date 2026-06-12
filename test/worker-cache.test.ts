import { describe, expect, it } from "vitest";
import {
  BROWSER_TTL_SECONDS,
  PAGE_TTL_SECONDS,
  STATIC_TTL_SECONDS,
  buildCacheKey,
  cacheRuleFor,
  shouldBypassCache,
  withCacheHeaders,
} from "../worker/cache";

describe("cacheRuleFor", () => {
  it("caches pages briefly and metadata routes for an hour", () => {
    expect(cacheRuleFor("/")).toEqual({ ttlSeconds: PAGE_TTL_SECONDS });
    expect(cacheRuleFor("/a/BA")).toEqual({ ttlSeconds: PAGE_TTL_SECONDS });
    expect(cacheRuleFor("/a/BA/s/STOP1")).toEqual({
      ttlSeconds: PAGE_TTL_SECONDS,
    });
    expect(cacheRuleFor("/a/BA/r/ROUTE1")).toEqual({
      ttlSeconds: PAGE_TTL_SECONDS,
    });
    expect(cacheRuleFor("/sitemap.xml")).toEqual({
      ttlSeconds: STATIC_TTL_SECONDS,
    });
    expect(cacheRuleFor("/robots.txt")).toEqual({
      ttlSeconds: STATIC_TTL_SECONDS,
    });
  });

  it("never caches API routes (TRMNL devices need fresh data)", () => {
    expect(cacheRuleFor("/api/trmnl/data")).toBeNull();
    expect(cacheRuleFor("/api/trmnl/markup")).toBeNull();
    expect(cacheRuleFor("/api/trmnl/preview/full")).toBeNull();
  });

  it("leaves unknown paths uncached", () => {
    expect(cacheRuleFor("/favicon.svg")).toBeNull();
    expect(cacheRuleFor("/admin")).toBeNull();
  });
});

describe("shouldBypassCache", () => {
  const url = "https://transit.directory/a/BA";

  it("allows plain GET requests", () => {
    expect(shouldBypassCache(new Request(url))).toBe(false);
  });

  it("bypasses non-GET methods", () => {
    expect(shouldBypassCache(new Request(url, { method: "POST" }))).toBe(true);
    expect(shouldBypassCache(new Request(url, { method: "HEAD" }))).toBe(true);
  });

  it("bypasses requests carrying cookies or authorization", () => {
    expect(
      shouldBypassCache(new Request(url, { headers: { cookie: "sid=1" } })),
    ).toBe(true);
    expect(
      shouldBypassCache(
        new Request(url, { headers: { authorization: "Bearer x" } }),
      ),
    ).toBe(true);
  });

  it("bypasses RSC negotiation requests so flight payloads never cache", () => {
    expect(shouldBypassCache(new Request(url, { headers: { rsc: "1" } }))).toBe(
      true,
    );
    expect(
      shouldBypassCache(
        new Request(url, { headers: { "next-router-state-tree": "x" } }),
      ),
    ).toBe(true);
    expect(
      shouldBypassCache(
        new Request(url, { headers: { "next-router-prefetch": "1" } }),
      ),
    ).toBe(true);
  });
});

describe("buildCacheKey", () => {
  it("keys on the full URL including the query string", () => {
    const key = buildCacheKey(
      new Request("https://transit.directory/a/BA/t/1?stop=4", {
        headers: { "x-extra": "ignored" },
      }),
    );
    expect(key.url).toBe("https://transit.directory/a/BA/t/1?stop=4");
    expect(key.method).toBe("GET");
  });
});

describe("withCacheHeaders", () => {
  it("sets shared and browser cache lifetimes", () => {
    const result = withCacheHeaders(new Response("ok"), 60);
    expect(result.headers.get("cache-control")).toBe(
      `public, max-age=${BROWSER_TTL_SECONDS}, s-maxage=60`,
    );
  });

  it("preserves the response body and status", async () => {
    const result = withCacheHeaders(
      new Response("body", { status: 200, headers: { "x-keep": "1" } }),
      30,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("x-keep")).toBe("1");
    expect(await result.text()).toBe("body");
  });
});
