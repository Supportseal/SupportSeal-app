import { describe, expect, it } from "vitest";

import { COLLECTOR_JS } from "@/lib/diagnostics/collector-source";

/**
 * Static ban gate (DX-05): scan the collector's shipped source for banned
 * identifiers (docs/design/diagnostics.md "Hard bans"). Adding a banned read
 * requires deliberately changing this test, which a reviewer sees.
 */
const BANNED = [
  "document.cookie",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  ".headers",
  "getAllResponseHeaders",
  "getResponseHeader",
  ".clone(",
  ".json(",
  ".text(",
  ".blob(",
  ".arrayBuffer(",
  ".formData(",
  "FormData",
  ".value",
  "JSON.stringify",
  "console.log",
  "console.info",
  "console.debug",
];

describe("collector ban gate (DX-05)", () => {
  it("ships without any banned identifier", () => {
    const hits = BANNED.filter((banned) => COLLECTOR_JS.includes(banned));
    expect(hits, `banned identifiers found in collector source: ${hits.join(", ")}`).toEqual([]);
  });

  it("the gate itself fails when a banned identifier is added", () => {
    const poisoned = `${COLLECTOR_JS} // document.cookie`;
    const hits = BANNED.filter((banned) => poisoned.includes(banned));
    expect(hits).toContain("document.cookie");
  });

  it("collects the documented event kinds (sanity on the shipped surface)", () => {
    for (const kind of ["js_error", "promise_rejection", "warning", "network"]) {
      expect(COLLECTOR_JS).toContain(`'${kind}'`);
    }
  });
});
