import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as loaderJs } from "@/app/api/widget/js/route";
import { brand } from "@/lib/brand";

vi.mock("@/lib/widget", () => ({
  loadWidgetProduct: async () => null,
  serviceOriginFrom: () => "http://localhost:3000",
}));

import { GET as panelHtml } from "@/app/api/widget/panel/route";

/**
 * Issue #57: both served widget scripts must embed the shared retry policy
 * (the module first, so window.__ssWidgetRetry exists before they run) and
 * stay syntactically valid — compiled here with new Function, never run.
 */
describe("served widget scripts (issue #57)", () => {
  it("loader embeds the retry policy before its IIFE and compiles", async () => {
    const text = await (await loaderJs()).text();
    const retryAt = text.indexOf("global.__ssWidgetRetry = api");
    const loaderAt = text.indexOf("if (window.__supportsealWidget)");
    expect(retryAt).toBeGreaterThan(-1);
    expect(loaderAt).toBeGreaterThan(retryAt);
    expect(text).toContain("configRetry");
    // The loader has no Retry button, so it keeps the old ~45 s outage window.
    expect(text).toMatch(/createRetry\(\{\s*maxAuto: 5,/);
    new Function(text);
  });

  it("panel embeds the retry policy before its IIFE and compiles", async () => {
    const html = await (
      await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
    ).text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const retryAt = (script ?? "").indexOf("global.__ssWidgetRetry = api");
    const panelAt = (script ?? "").indexOf("var params =");
    expect(retryAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(retryAt);
    expect(script).toContain("bootRetry");
    expect(script).toContain("streamRetry");
    expect(script).toContain("pollState");
    // Non-preview polling must schedule through the shared backoff (the
    // preview branch's fixed interval makes no server requests).
    expect(script).toContain("schedulePoll(retryApi.backoffDelay");
    new Function(script ?? "");
  });

  it("loader replays ss:open when the launcher click beat the panel load", async () => {
    const text = await (await loaderJs()).text();
    const onLoad = text.slice(text.indexOf("frame.addEventListener('load'"));
    expect(onLoad.slice(0, 600)).toMatch(/if \(open && frame\.contentWindow\) \{\s*frame\.contentWindow\.postMessage\(\{ type: 'ss:open' \}/);
  });

  it("panel renders on open and reconnects a silent stream", async () => {
    const html = await (
      await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
    ).text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    const onOpen = script.slice(script.indexOf("data.type === 'ss:open'"));
    expect(onOpen.slice(0, 300)).toContain("if (config) render();");
    expect(script).toContain("source.addEventListener('heartbeat', armWatchdog)");
    // Enter calls send() directly, so the in-flight guard must live inside it.
    expect(script).toMatch(/function send\(\) \{\s*(\/\/[^\n]*\s*)*if \(sending \|\| uploading\.length > 0\) return;/);
    expect(script).toMatch(/setTimeout\(function \(\) \{ failStream\(source\); \}, STREAM_SILENCE_MS\)/);
  });
  it("panel chimes only for AGENT messages the thread has not seen (issue #125)", async () => {
    const html = await (
      await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
    ).text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(script.indexOf("__ssWidgetSound = api")).toBeGreaterThan(-1);
    expect(script.indexOf("__ssWidgetSound = api")).toBeLessThan(script.indexOf("var params ="));
    expect(html).toContain('id="soundBtn"');
    // Both live paths gate the chime on the helper; history (boot) never calls it.
    expect(script).toMatch(/hasNewAgentReply\(state\.messages, incoming\)\) chime\.notify\(\)/);
    expect(script).toMatch(/!previewMode && hasNewAgentReply\(prev, incoming\)\) chime\.notify\(\)/);
    // POST snapshots (normal send and away form) replace the thread before the
    // stream does, so they must run the same check.
    expect(script).toMatch(/hasNewAgentReply\(state\.messages, sent\)\) chime\.notify\(\)/);
    expect(script).toMatch(/hasNewAgentReply\(state\.messages, saved\)\) chime\.notify\(\)/);
    const helper = /function hasNewAgentReply\(known, incoming\) \{[\s\S]*?\n  \}/.exec(script)?.[0] ?? "";
    const hasNewAgentReply = new Function(`${helper}; return hasNewAgentReply;`)() as (
      known: Array<{ id: string }>,
      incoming: Array<{ id: string; kind: string }>,
    ) => boolean;
    const history = [{ id: "a", kind: "AGENT" }, { id: "c", kind: "CUSTOMER" }];
    expect(hasNewAgentReply(history, history)).toBe(false);
    expect(hasNewAgentReply(history, [...history, { id: "c2", kind: "CUSTOMER" }])).toBe(false);
    expect(hasNewAgentReply(history, [...history, { id: "a2", kind: "AGENT" }])).toBe(true);
    expect(hasNewAgentReply([], [{ id: "a", kind: "AGENT" }])).toBe(true);
  });

  it("panel opens the visitor stream only once a conversation exists (issue #190)", async () => {
    const html = await (
      await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
    ).text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    // The server answers 401 until a conversation exists, so startStream bails
    // out first; the first send and the away form record the conversation
    // before they open the stream.
    expect(script).toMatch(/if \(!state\.conversationId\) return;\s*streamRetry\.reset\(\);\s*streamRetry\.run\(\);/);
    expect(script).toMatch(
      /state\.conversationId = result\.data\.thread\.conversationId;[^]*?if \(!streamActive && !previewMode\) startStream\(\);/,
    );
    expect(script).toMatch(
      /state\.conversationId = data\.thread\.conversationId;\s*state\.ticketRef = data\.thread\.ticketRef \|\| null;\s*render\(\);\s*\}\s*else restoreDiagnostics\(\);\s*if \(!streamActive && !previewMode\) startStream\(\);/,
    );
  });

  it("loader delegates autoplay to the panel frame so replies can chime before a click in it", async () => {
    const text = await (await loaderJs()).text();
    expect(text).toContain("frame.setAttribute('allow', 'clipboard-write; autoplay')");
  });

  describe("origin allowlist miss (issue #152)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Runs the served loader against stubbed browser globals. */
    async function runLoader(response: { status: number; body: unknown }) {
      vi.useFakeTimers();
      const text = await (await loaderJs()).text();
      const script = {
        src: "https://dash.example.test/widget.js",
        getAttribute: (name: string) => (name === "data-key" ? "pk_test" : null),
      };
      const fetchStub = vi.fn(async () => ({
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        json: async () => response.body,
      }));
      const errorStub = vi.fn();
      const win = {
        location: { origin: "https://customer.example.org", hostname: "customer.example.org" },
        innerWidth: 1200,
        addEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      };
      const doc = {
        currentScript: script,
        readyState: "complete",
        hidden: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      new Function("window", "document", "fetch", "console", "history", text)(
        win,
        doc,
        fetchStub,
        { error: errorStub },
        { pushState: () => undefined },
      );
      await vi.advanceTimersByTimeAsync(0);
      return { fetchStub, errorStub, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
    }

    it("logs one console error naming the host and stops retrying", async () => {
      const { fetchStub, errorStub, advance } = await runLoader({
        status: 403,
        body: { error: "origin_not_allowed" },
      });
      await advance(120_000);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(errorStub).toHaveBeenCalledTimes(1);
      const message = String(errorStub.mock.calls[0][0]);
      expect(message).toContain(`[${brand.name}]`);
      expect(message).toContain("https://customer.example.org");
      expect(message).toContain("https://dash.example.test/settings/products");
    });

    it.each([403, 404, 500])("keeps retrying silently on unrelated %s failures", async (status) => {
      const { fetchStub, errorStub, advance } = await runLoader({ status, body: {} });
      await advance(120_000);
      expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
      expect(errorStub).not.toHaveBeenCalled();
    });
  });

  it("loader exposes reset() and the q-queue 'reset' entry, dropping stale identify/context (issue #151)", async () => {
    const text = await (await loaderJs()).text();
    expect(text).toMatch(/reset: function \(\) \{ resetSession\(\); \}/);
    expect(text).toContain("if (type === 'reset') resetSession();");
    // Identity queued for the signed-out user is discarded before ss:reset is queued.
    expect(text).toMatch(/apiQueue\.length = 0;[^]*?window\.__ssDiag\.pause\(\)[^]*?diagUserEnabled[^]*?enqueue\('reset', \{\}\);/);
    new Function(text);
  });

  it("panel resets on ss:reset: revokes server-side before re-booting and ignores the retired session (issue #151)", async () => {
    const html = await (
      await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
    ).text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).toContain("if (data.type === 'ss:reset') resetSession();");
    // Boot sends the DELETE first while a reset is pending, and only then clears the token.
    expect(script).toMatch(/resetPending\s*\? apiFetch\('\/api\/widget\/session', \{ method: 'DELETE', keepalive: true \}\)/);
    expect(script.indexOf("method: 'DELETE'")).toBeLessThan(script.indexOf("{ method: 'POST' }"));
    expect(script).toMatch(/resetPending = false; clearResetFlag\(\); removeToken\(\)/);
    // Stale boot / developer-data / send results are fenced by the generation counter.
    expect(script).toMatch(
      /if \(generation !== sessionGeneration\) return;\s*return apiFetch\('\/api\/widget\/session', \{ method: 'POST' \}\)/,
    );
    expect(script).toContain("if (generation !== sessionGeneration) return null;");
    expect(script).toContain("if (sendGeneration !== sessionGeneration) return;");
    expect(script).toContain("if (resetPending && !previewMode) return;");
    // Diagnostics-delayed sends, uploads, email saves and the away chain are fenced too.
    expect(script).toContain("if (sendGeneration !== sessionGeneration) return Promise.reject('superseded');");
    expect(script).toContain("if (uploadGeneration !== sessionGeneration) return;");
    expect(script).toContain("if (emailGeneration !== sessionGeneration) return {};");
    expect(script).toContain("if (awayGeneration !== sessionGeneration) return;");
    expect(script).toContain("if (resetPending && !previewMode) { hint.textContent");
    expect(script).toContain("if (resetPending) return;");
    expect(script).toMatch(/if \(activeSource !== source\) return;\s*armWatchdog\(\);/);
    expect(script).toMatch(/state\.conversationId = null;\s*state\.ticketRef = null;\s*lastCount = 0;/);
    expect(script).toMatch(/fileInput\.value = '';\s*\/\/[^\n]*\s*if \(resetPending && !previewMode\) return;/);
    new Function(script);
  });
});
