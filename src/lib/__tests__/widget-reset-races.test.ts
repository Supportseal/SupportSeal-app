import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/widget", () => ({
  loadWidgetProduct: async () => null,
  serviceOriginFrom: () => "http://localhost:3000",
}));
import { GET as panelHtml } from "@/app/api/widget/panel/route";

/** Source of one top-level function of the served panel script. */
async function panelFunction(name: string) {
  const html = await (
    await panelHtml(new NextRequest("http://localhost:3000/widget?key=pk_test&host=http://localhost:3000"))
  ).text();
  const source = new RegExp(`  function ${name}\\([^]*?\\n  \\}`).exec(html)?.[0];
  expect(source).toBeTruthy();
  return source!;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** In-memory stand-in for the panel iframe's sessionStorage. */
function fakeSessionStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("widget reset intent survives navigation (#151, P2)", () => {
  const helpers = async () =>
    [await panelFunction("resetFlagged"), await panelFunction("flagReset"), await panelFunction("clearResetFlag")].join("\n");

  it("resetSession persists the intent before anything async can be lost", async () => {
    const storage = fakeSessionStorage();
    const scope = {
      sessionStorage: storage, resetKey: "ss_reset_pk_test", previewMode: false,
      sessionGeneration: 0, resetPending: false, booted: true, devQueue: [1],
      streamRetry: { reset: vi.fn() }, stopPolling: vi.fn(), activeSource: null, streamActive: true,
      state: { messages: [{}] }, lastCount: 3, sending: true, pendingAttachments: [1],
      renderChips: vi.fn(), input: { value: "x", style: {} }, updateSendState: vi.fn(),
      document: { getElementById: () => ({ value: "x", disabled: true }) },
      hideBanner: vi.fn(), config: null, render: vi.fn(), bootRetry: { reset: vi.fn(), run: vi.fn() },
    };
    const reset = runInNewContext(`${await helpers()}\n${await panelFunction("resetSession")}; resetSession`, scope);
    reset();
    expect(storage.data.get("ss_reset_pk_test")).toBe("1");
    expect(scope.bootRetry.run).toHaveBeenCalledOnce();
  });

  it("a second reset while the revocation is still pending is the same operation", async () => {
    const storage = fakeSessionStorage();
    const scope = {
      sessionStorage: storage, resetKey: "ss_reset_pk_test", previewMode: false,
      sessionGeneration: 0, resetPending: false, booted: true, devQueue: [],
      streamRetry: { reset: vi.fn() }, stopPolling: vi.fn(), activeSource: null, streamActive: true,
      state: { messages: [] }, lastCount: 0, sending: false, pendingAttachments: [],
      renderChips: vi.fn(), input: { value: "", style: {} }, updateSendState: vi.fn(),
      document: { getElementById: () => ({ value: "", disabled: false }) },
      hideBanner: vi.fn(), config: null, render: vi.fn(), bootRetry: { reset: vi.fn(), run: vi.fn() },
    };
    const reset = runInNewContext(`${await helpers()}
${await panelFunction("resetSession")}; resetSession`, scope);
    reset();
    reset();
    expect(scope.bootRetry.run).toHaveBeenCalledOnce();
    expect(scope.sessionGeneration).toBe(1);
  });

  it("a fresh page with a stored intent revokes first and clears the intent only after the DELETE succeeds", async () => {
    const storage = fakeSessionStorage({ ss_reset_pk_test: "1" });
    const apiFetch = vi.fn();
    const scope = {
      sessionStorage: storage, resetKey: "ss_reset_pk_test", previewMode: false, sessionGeneration: 0,
      parent: { postMessage: vi.fn() }, apiFetch, removeToken: vi.fn(), bootRetry: { success: vi.fn(), fail: vi.fn() },
      hideBanner: vi.fn(), persistToken: vi.fn(), probeCookieTransport: vi.fn(), applyConfig: vi.fn(),
      state: {}, lastCount: 0, render: vi.fn(), flushDevQueue: vi.fn(), startStream: vi.fn(),
    };
    const boot = runInNewContext(
      `${await helpers()}\nvar resetPending = resetFlagged();\n${await panelFunction("boot")}; ({ boot, pending: () => resetPending })`,
      scope,
    );
    expect(boot.pending()).toBe(true);

    // DELETE fails: the intent must stay owed (and the stored token untouched).
    apiFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    boot.boot();
    await flush();
    expect(apiFetch).toHaveBeenCalledWith("/api/widget/session", { method: "DELETE", keepalive: true });
    expect(storage.data.get("ss_reset_pk_test")).toBe("1");
    expect(scope.removeToken).not.toHaveBeenCalled();
    expect(scope.bootRetry.fail).toHaveBeenCalledOnce();
    // Not acknowledged yet: the host page keeps asking for the reset.
    expect(scope.parent.postMessage).not.toHaveBeenCalled();

    // DELETE succeeds, then a fresh session is requested.
    apiFetch.mockResolvedValueOnce({ ok: true });
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: "fresh" }) });
    boot.boot();
    await flush();
    expect(storage.data.has("ss_reset_pk_test")).toBe(false);
    expect(scope.removeToken).toHaveBeenCalledOnce();
    expect(apiFetch).toHaveBeenLastCalledWith("/api/widget/session", { method: "POST" });
    expect(boot.pending()).toBe(false);
    expect(scope.parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ss:reset-ack" }, "*");
  });

  it("blocked storage degrades to in-memory intent without throwing", async () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const scope = { sessionStorage: blocked, resetKey: "k" };
    const api = runInNewContext(`${await helpers()}; ({ resetFlagged, flagReset, clearResetFlag })`, scope);
    expect(api.resetFlagged()).toBe(false);
    expect(() => { api.flagReset(); api.clearResetFlag(); }).not.toThrow();
  });
});

describe("poll responses are fenced by the session generation (#151, P3)", () => {
  it.each(["success", "failure"])("ignores an old poll %s after reset, even when new polling has started", async (outcome) => {
    const source = await panelFunction("poll");
    let resolve!: (value: object) => void;
    let reject!: (error: Error) => void;
    const request = new Promise((res, rej) => { resolve = res; reject = rej; });
    const scope = {
      previewMode: false, sessionGeneration: 1, apiFetch: () => request,
      state: { messages: [], conversationId: null }, lastCount: 0, hidden: false,
      pollSuccess: vi.fn(), pollFailure: vi.fn(), reportUnread: vi.fn(),
      render: vi.fn(), hasNewAgentReply: () => true, chime: { notify: vi.fn() },
    };
    runInNewContext(source + "; poll()", scope);
    scope.sessionGeneration++; // reset() lands while the poll is in flight
    if (outcome === "success") {
      resolve({ ok: true, json: async () => ({ thread: { messages: [{ id: "private" }], conversationId: "old" } }) });
    } else {
      reject(new Error("old request failed"));
    }
    await flush();
    expect(scope.state).toEqual({ messages: [], conversationId: null });
    for (const fn of [scope.pollSuccess, scope.pollFailure, scope.render, scope.reportUnread, scope.chime.notify]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("still applies a poll whose generation is current", async () => {
    const source = await panelFunction("poll");
    const scope = {
      previewMode: false, sessionGeneration: 1,
      apiFetch: async () => ({ ok: true, json: async () => ({ thread: { messages: [{ id: "m1" }], conversationId: "c1" } }) }),
      state: { messages: [], conversationId: null }, lastCount: 0, hidden: false,
      pollSuccess: vi.fn(), pollFailure: vi.fn(), reportUnread: vi.fn(),
      render: vi.fn(), hasNewAgentReply: () => false, chime: { notify: vi.fn() },
    };
    runInNewContext(source + "; poll()", scope);
    await flush();
    expect(scope.state.conversationId).toBe("c1");
    expect(scope.pollSuccess).toHaveBeenCalledOnce();
  });
});
