import { afterEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    queryRaw.mockReset();
  });

  it("is ok when the database answers and the auth secret is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "s3cret");
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("is unhealthy in production without BETTER_AUTH_SECRET, without touching the database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "  ");

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "misconfigured", auth: "BETTER_AUTH_SECRET is not set" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("does not require the secret outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    queryRaw.mockResolvedValue([]);

    expect((await GET()).status).toBe(200);
  });

  it("is degraded when the database is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_SECRET", "s3cret");
    queryRaw.mockRejectedValue(new Error("down"));

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", database: "unavailable" });
  });
});
