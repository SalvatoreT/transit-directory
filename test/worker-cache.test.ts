import { describe, expect, it } from "vitest";
import {
  BROWSER_TTL_SECONDS,
  PAGE_TTL_SECONDS,
  STATIC_TTL_SECONDS,
  cacheRuleFor,
  shouldBypassCache,
  withCacheHeaders,
  withPrivateHeaders,
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

describe("withCacheHeaders", () => {
  it("sets shared and browser cache lifetimes", () => {
    const result = withCacheHeaders(new Response("ok"), 60);
    expect(result.headers.get("cache-control")).toBe(
      `public, max-age=${BROWSER_TTL_SECONDS}, s-maxage=60`,
    );
  });

  it("varies on RSC negotiation headers so flight payloads never collide", () => {
    const result = withCacheHeaders(new Response("ok"), 60);
    const vary = (result.headers.get("vary") || "").toLowerCase();
    expect(vary).toContain("rsc");
    expect(vary).toContain("next-router-state-tree");
    expect(vary).toContain("next-router-prefetch");
  });

  it("keeps a Vary the framework already set", () => {
    const result = withCacheHeaders(
      new Response("ok", { headers: { Vary: "Accept-Encoding" } }),
      60,
    );
    const vary = (result.headers.get("vary") || "").toLowerCase();
    expect(vary).toContain("accept-encoding");
    expect(vary).toContain("rsc");
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

describe("withPrivateHeaders", () => {
  it("marks the response uncacheable in the shared cache", () => {
    const result = withPrivateHeaders(new Response("ok"));
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("preserves the response body and status", async () => {
    const result = withPrivateHeaders(
      new Response("body", { status: 200, headers: { "x-keep": "1" } }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("x-keep")).toBe("1");
    expect(await result.text()).toBe("body");
  });
});
