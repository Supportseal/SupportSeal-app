import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #219, OpenCode P3: pin MULTI_HOP_WARNING in client-ip.ts. Docs
 * (hosted deployment verification) tell operators to watch the log for it,
 * so a refactor that drops or alters the one-shot warnOnce must fail here.
 */

type ClientIp = typeof import("@/lib/client-ip");

let clientIpModule: ClientIp;

beforeEach(async () => {
  vi.resetModules();
  clientIpModule = await import("@/lib/client-ip");
});

describe("multi-hop x-forwarded-for warning (issue #219)", () => {
  const ENV_KEY = "TRUSTED_PROXY_HEADER";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    vi.restoreAllMocks();
  });

  it("warns exactly once for multi-hop x-forwarded-for and keys on the last entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      expect(
        clientIpModule.clientIp({ headers: new Headers({ "x-forwarded-for": `spoof-${i}, 203.0.113.66` }) }),
      ).toBe("203.0.113.66");
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("several entries");
  });

  it("does not warn for a single x-forwarded-for entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(clientIpModule.clientIp({ headers: new Headers({ "x-forwarded-for": "203.0.113.66" }) })).toBe("203.0.113.66");
    expect(warn).not.toHaveBeenCalled();
  });
});
