import { afterEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

import { GET } from "@/app/api/health/live/route";

// The container HEALTHCHECK probes this every 30 s; a database query here
// would keep a scale-to-zero database (Neon) awake around the clock.
describe("GET /api/health/live", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    queryRaw.mockReset();
  });

  it("is ok without touching the database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db/x");

    const res = GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("is unhealthy in production without BETTER_AUTH_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "");

    const res = GET();

    expect(res.status).toBe(503);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("is unhealthy in production without DATABASE_URL, still without connecting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", " ");

    const res = GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "misconfigured", database: "DATABASE_URL is not set" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("the image HEALTHCHECK uses the database-free probe", async () => {
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*\n[^\n]*\/api\/health\/live'/);
  });
});
