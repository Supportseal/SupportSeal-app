import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OWNER_KEY, RESET_ACKNOWLEDGED_EVENT, RESET_PENDING_KEY } from "@/lib/support-widget-session";

/** Browser stand-in: localStorage plus the widget queue the loader drains. */
function stubBrowser({ storageBlocked = false } = {}) {
  const data = new Map<string, string>();
  const entries: unknown[][] = [];
  const events = new EventTarget();
  const localStorage = storageBlocked
    ? {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      }
    : {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      };
  vi.stubGlobal("window", {
    localStorage,
    SupportSealWidget: { q: { push: (entry: unknown[]) => entries.push(entry) } },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  return { data, entries, acknowledge: () => events.dispatchEvent(new Event(RESET_ACKNOWLEDGED_EVENT)) };
}

async function load() {
  vi.resetModules();
  return import("@/lib/support-widget-session");
}

describe("support widget session guard", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("resets when the stored session belongs to another dashboard user", async () => {
    const browser = stubBrowser();
    browser.data.set(OWNER_KEY, "user-a");
    (await load()).syncWidgetOwner("user-b");
    expect(browser.entries).toEqual([["reset"]]);
    expect(browser.data.get(OWNER_KEY)).toBe("user-b");
  });

  it("resets on the sign-in page after the owner's session expired (nobody signed in)", async () => {
    const browser = stubBrowser();
    browser.data.set(OWNER_KEY, "user-a");
    (await load()).syncWidgetOwner(undefined);
    expect(browser.entries).toEqual([["reset"]]);
    expect(browser.data.has(OWNER_KEY)).toBe(false);
  });

  it("keeps the thread of the same user and of anonymous visitors", async () => {
    const browser = stubBrowser();
    const { syncWidgetOwner } = await load();
    syncWidgetOwner(undefined);
    expect(browser.entries).toEqual([]);
    browser.data.set(OWNER_KEY, "user-a");
    syncWidgetOwner("user-a");
    expect(browser.entries).toEqual([]);
  });

  it("explicit sign-out resets and forgets the owner", async () => {
    const browser = stubBrowser();
    browser.data.set(OWNER_KEY, "user-a");
    (await load()).resetSupportWidget();
    expect(browser.entries).toEqual([["reset"]]);
    expect(browser.data.has(OWNER_KEY)).toBe(false);
  });

  it("a reset that never reached the panel is asked again on the next mount, even with no owner left", async () => {
    const browser = stubBrowser();
    browser.data.set(OWNER_KEY, "user-a");
    (await load()).syncWidgetOwner(undefined);
    expect(browser.data.get(RESET_PENDING_KEY)).toBe("1");

    // The document was left before the loader built its panel: a new page.
    browser.entries.length = 0;
    (await load()).syncWidgetOwner(undefined);
    expect(browser.entries).toEqual([["reset"]]);
  });

  it("stops asking once the panel acknowledged the reset", async () => {
    const browser = stubBrowser();
    browser.data.set(OWNER_KEY, "user-a");
    const { syncWidgetOwner } = await load();
    syncWidgetOwner(undefined);
    browser.acknowledge();
    expect(browser.data.has(RESET_PENDING_KEY)).toBe(false);

    browser.entries.length = 0;
    syncWidgetOwner(undefined);
    expect(browser.entries).toEqual([]);
  });

  it("a pending reset runs before the next user is identified", async () => {
    const browser = stubBrowser();
    browser.data.set(RESET_PENDING_KEY, "1");
    const { syncWidgetOwner, identifyWidgetUser } = await load();
    syncWidgetOwner("user-b");
    identifyWidgetUser({ id: "user-b", email: "b@example.test", name: "B" });
    expect(browser.entries.map((e) => e[0])).toEqual(["reset", "identify"]);
  });

  it("keeps working when storage is blocked", async () => {
    const browser = stubBrowser({ storageBlocked: true });
    const { syncWidgetOwner, resetSupportWidget } = await load();
    expect(() => syncWidgetOwner("user-a")).not.toThrow();
    expect(() => resetSupportWidget()).not.toThrow();
    expect(browser.entries).toEqual([["reset"]]);
  });
});
