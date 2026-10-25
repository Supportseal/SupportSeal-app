import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as route from "@/app/api/openapi.json/route";

/**
 * GET /api/openapi.json serves the same docs/openapi.json the drift test
 * checks, so these tests compare the served body against that file.
 */

const file = JSON.parse(readFileSync(path.join(process.cwd(), "docs", "openapi.json"), "utf8"));
const get = (headers: Record<string, string> = {}) => route.GET(new Request("http://0.0.0.0:3000/api/openapi.json", { headers }));

describe("GET /api/openapi.json", () => {
  it("serves docs/openapi.json, with only the server default swapped for the request origin", async () => {
    const res = get({ host: "support.example.com", "x-forwarded-proto": "https" });
    expect(res.status).toBe(200);
    const served = await res.json();

    const expected = structuredClone(file);
    expected.servers[0].variables.baseUrl.default = "https://support.example.com";
    expect(served).toEqual(expected);
    expect(file.servers[0].variables.baseUrl.default).toBe("https://dashboard.supportseal.app");
  });

  it("honours x-forwarded-host and x-forwarded-proto over the bind address", async () => {
    const served = await get({ host: "0.0.0.0:3000", "x-forwarded-host": "help.acme.test", "x-forwarded-proto": "https" }).json();
    expect(served.servers[0].variables.baseUrl.default).toBe("https://help.acme.test");
  });

  it("normalises valid forwarded origins: default ports, case, IPv6 and explicit ports", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "x-forwarded-host": "support.example.com:443", "x-forwarded-proto": "https" }, "https://support.example.com"],
      [{ "x-forwarded-host": "support.example.com:80", "x-forwarded-proto": "http" }, "http://support.example.com"],
      [{ host: "Support.Example.com", "x-forwarded-proto": "HTTPS" }, "https://support.example.com"],
      [{ host: "support.example.com:8443", "x-forwarded-proto": "https" }, "https://support.example.com:8443"],
      [{ host: "localhost:3000" }, "http://localhost:3000"],
      [{ host: "[::1]:3000", "x-forwarded-proto": "http" }, "http://[::1]:3000"],
    ];
    for (const [headers, expected] of cases) {
      const served = await get(headers).json();
      expect(served.servers[0].variables.baseUrl.default, JSON.stringify(headers)).toBe(expected);
    }
  });

  it("falls back to the file's own default when the origin is unusable", async () => {
    for (const host of ["evil.example/path", "evil.example/", "user@evil.example", "a b", "evil.example?x=1", "evil.example#f", "evil.example\\x"]) {
      const served = await get({ host, "x-forwarded-proto": "https" }).json();
      expect(served.servers[0].variables.baseUrl.default, host).toBe(file.servers[0].variables.baseUrl.default);
    }
  });

  it("rejects a non-http(s) forwarded protocol", async () => {
    const served = await get({ host: "support.example.com", "x-forwarded-proto": "javascript" }).json();
    expect(served.servers[0].variables.baseUrl.default).toBe(file.servers[0].variables.baseUrl.default);
  });

  it("is public (no credentials), browser-cacheable and CORS-open JSON, but never storable by a shared cache", () => {
    const res = get({ host: "support.example.com" });
    expect(res.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("etag")).toMatch(/^"[\w-]+"$/u);
    expect(res.headers.get("vary")?.toLowerCase()).toContain("x-forwarded-host");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("never yields a publicly cacheable response, however the origin is spoofed or conditional requests are made", () => {
    const etag = get({ host: "support.example.com" }).headers.get("etag")!;
    const requests: Record<string, string>[] = [
      { host: "support.example.com" },
      { host: "support.example.com", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      { "x-forwarded-host": "evil.example:443", "x-forwarded-proto": "HTTPS" },
      { host: "support.example.com", "if-none-match": etag },
      {},
    ];
    for (const headers of requests) {
      const res = get(headers);
      const cacheControl = res.headers.get("cache-control") ?? "";
      expect(cacheControl, JSON.stringify(headers)).toMatch(/\bprivate\b/u);
      expect(cacheControl, JSON.stringify(headers)).not.toMatch(/\b(public|s-maxage)\b/u);
      expect(res.headers.get("vary")?.toLowerCase(), JSON.stringify(headers)).toMatch(/x-forwarded-host.*x-forwarded-proto|x-forwarded-proto.*x-forwarded-host/u);
    }
  });

  it("needs no credentials: an Authorization header or cookie changes nothing", async () => {
    const plain = await get({ host: "support.example.com" }).text();
    const withCreds = await get({ host: "support.example.com", authorization: "Bearer ss_live_bogus", cookie: "better-auth.session_token=x" }).text();
    expect(withCreds).toBe(plain);
  });

  it("answers 304 with no body to a matching If-None-Match, and 200 once the origin (so the body) changes", async () => {
    const first = get({ host: "support.example.com" });
    const etag = first.headers.get("etag")!;

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = get({ host: "support.example.com", "if-none-match": header });
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }

    const other = get({ host: "other.example.com", "if-none-match": etag });
    expect(other.status).toBe(200);
    expect(other.headers.get("etag")).not.toBe(etag);
  });

  it("is GET only: no other method handler is exported (Next answers those 405)", () => {
    const methods = ["POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof (route as Record<string, unknown>)[m] === "function");
    expect(methods).toEqual([]);
  });
});
