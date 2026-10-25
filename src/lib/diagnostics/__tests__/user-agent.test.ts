import { describe, expect, it } from "vitest";

import { parseUserAgent } from "@/lib/diagnostics/user-agent";

describe("parseUserAgent (family + major version, DX-06 fixtures)", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      { browser: "Chrome 129", os: "Windows 10" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      { browser: "Edge 128", os: "macOS 10" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
      { browser: "Safari 17", os: "iOS 17" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      { browser: "Chrome 129", os: "Android 14" },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      { browser: "Firefox 130", os: "Linux" },
    ],
    [
      "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
      { browser: "Opera 106", os: "Windows 7" },
    ],
    ["curl/8.7.1", { browser: "Other", os: "Other" }],
  ])("%s → %s", (ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it("the raw user agent string is not echoed into the label", () => {
    const label = parseUserAgent(
      "Mozilla/5.0 (Windows NT 10.0) Chrome/129.0.0.0 Safari/537.36",
    );
    expect(JSON.stringify(label)).not.toContain("Mozilla");
  });
});
