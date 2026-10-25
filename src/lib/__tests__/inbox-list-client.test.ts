import { describe, expect, it, vi } from "vitest";

import { InboxListClient, reconcileInboxPages, type InboxPage } from "@/lib/inbox-list-client";

// Rows are ordered by creation, oldest first: a higher id is a newer ticket.
type Item = { id: string; createdAt: string; lastMessageAt: string; preview: string };
const item = (id: number, preview = `Ticket ${id}`): Item => ({
  id: String(id),
  createdAt: new Date(100_000 + id * 1000).toISOString(),
  lastMessageAt: new Date(100_000 + id * 1000).toISOString(),
  preview,
});
const page = (items: Item[], nextCursor: string | null = null): InboxPage<Item> => ({
  items, nextCursor, statusCounts: { OPEN: 10 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("inbox reconciliation", () => {
  it("deduplicates overlapping pages, keeping fresh rows, server order and the tail cursor", () => {
    expect(reconcileInboxPages([
      page([item(0), item(1, "Fresh")], "1"),
      { ...page([item(1, "Stale"), item(2)], "2"), statusCounts: { OPEN: 9 } },
    ])).toEqual(page([item(0), item(1, "Fresh"), item(2)], "2"));
  });

  it("handles an exhausted empty page without dropping earlier rows", () => {
    expect(reconcileInboxPages([page([item(1)], "1"), page([])]))
      .toEqual(page([item(1)]));
  });
});

describe("InboxListClient", () => {
  it("refetches exactly the loaded range, updating rows on every page", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockResolvedValueOnce(page([item(3), item(4)], "4"))
      .mockResolvedValueOnce(page([item(1, "Updated"), item(2)], "2"))
      .mockResolvedValueOnce(page([item(3, "Older update"), item(4)], "4"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.loadMore();
    await client.refresh();
    expect(client.state.data).toEqual(page([
      item(1, "Updated"), item(2), item(3, "Older update"), item(4),
    ], "4"));
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "2", undefined, "2"]);
  });

  it("stops at the loaded range when the tail gets a reply or rows leave the tab", async () => {
    const replied = { ...item(4), lastMessageAt: new Date(900_000).toISOString() };
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockResolvedValueOnce(page([item(3), item(4)], "4"))
      // Ticket 1 closed elsewhere: later rows shift up and the tail replied.
      .mockResolvedValueOnce(page([item(2), item(3)], "3"))
      .mockResolvedValueOnce(page([replied, item(5)], "5"))
      .mockResolvedValueOnce(page([item(6), item(7)], "7"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.loadMore();
    await client.refresh();
    expect(client.state.data).toEqual(page([item(2), item(3), replied, item(5)], "5"));
    // The walk ended at the first page that reached past the old tail.
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("keeps the loaded tail when a reopened old ticket slots in mid-list", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(3)], "3"))
      .mockResolvedValueOnce(page([item(4), item(5)], "5"))
      // Ticket 2 was reopened and now sorts between 1 and 3.
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockResolvedValueOnce(page([item(3), item(4)], "4"))
      .mockResolvedValueOnce(page([item(5), item(6)], "6"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.loadMore();
    await client.refresh();
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("stops at a row created after the old tail when the old tail left the tab", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockResolvedValueOnce(page([item(1), item(3)], "3"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.refresh();
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1", "3"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("keeps walking through rows tied on createdAt until the old tail shows up", async () => {
    const tied = (id: number) => ({ ...item(1), id: String(id) });
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([tied(1), tied(2), tied(3)], "3"))
      .mockResolvedValueOnce(page([tied(1), tied(2)], "2"))
      .mockResolvedValueOnce(page([tied(3), item(4)], "4"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.refresh();
    expect(client.state.data?.items).toEqual([tied(1), tied(2), tied(3), item(4)]);
  });

  it("removes rows that no longer match and uses the refreshed terminal cursor", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockResolvedValueOnce(page([item(3), item(4)]))
      .mockResolvedValueOnce(page([item(1), item(4)]));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.loadMore();
    await client.refresh();
    expect(client.state.data).toEqual(page([item(1), item(4)]));
  });

  it.each(["resolve", "reject"] as const)("ignores a superseded Load more %s even if abort is ignored", async (outcome) => {
    const pending = deferred<InboxPage<Item>>();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1), item(2)], "2"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(page([item(0), item(1)], "1"))
      .mockResolvedValueOnce(page([item(2), item(3)], "3"));
    const publish = vi.fn();
    const client = new InboxListClient<Item>(fetchPage, publish);
    await client.refresh();
    const loading = client.loadMore();
    const signal = fetchPage.mock.calls[1][1] as AbortSignal;
    await client.refresh();
    expect(signal.aborted).toBe(true);
    const expected = client.state;
    publish.mockClear();
    if (outcome === "resolve") pending.resolve(page([item(2, "Stale"), item(4)], "obsolete"));
    else pending.reject(new Error("Late failure"));
    await loading;
    expect(client.state).toBe(expected);
    expect(publish).not.toHaveBeenCalled();
  });

  it("serializes double clicks and prevents Load more during a refresh", async () => {
    const pending = deferred<InboxPage<Item>>();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1)], "1"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(page([item(1), item(2)], "2"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    const loading = client.loadMore();
    await client.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    pending.resolve(page([item(2)], "2"));
    await loading;
    const refreshing = client.refresh();
    await client.loadMore();
    await refreshing;
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(client.state.error).toBe(false);
  });

  describe("loadMore outcome", () => {
    it("reports loaded, then exhausted once the last page is in", async () => {
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockResolvedValueOnce(page([item(2)]));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      expect(await client.loadMore()).toBe("loaded");
      expect(await client.loadMore()).toBe("exhausted");
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("reports skipped, not exhausted, while another request is in flight", async () => {
      const pending = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => pending.promise);
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      const refreshing = client.refresh();
      expect(await client.loadMore()).toBe("skipped");
      pending.resolve(page([item(1)], "1"));
      await refreshing;
    });

    it("reports skipped before the first page has arrived", async () => {
      const client = new InboxListClient<Item>(vi.fn(), vi.fn());
      expect(await client.loadMore()).toBe("skipped");
    });

    it("reports skipped when a refresh supersedes the fetch", async () => {
      const pending = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce(page([item(1)], "1"));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      const loading = client.loadMore();
      await client.refresh();
      pending.resolve(page([item(2)]));
      expect(await loading).toBe("skipped");
    });

    it("reports failed, not exhausted, when the fetch fails", async () => {
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockRejectedValueOnce(new Error("Offline"));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      expect(await client.loadMore()).toBe("failed");
      expect(client.state.error).toBe(true);
    });
  });

  describe("loadMoreSettled", () => {
    it("waits for the in-flight refresh, then loads the next page of what it returned", async () => {
      const pending = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce(page([item(2)]));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      const refreshing = client.refresh();
      const loading = client.loadMoreSettled();
      pending.resolve(page([item(1, "Fresh")], "1"));
      await refreshing;
      const result = await loading;
      expect(result.outcome).toBe("loaded");
      expect(result.items.map((row) => row.preview)).toEqual(["Fresh", "Ticket 2"]);
      expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, undefined, "1"]);
    });

    it("keeps waiting through a refresh that supersedes the one it waited on", async () => {
      const first = deferred<InboxPage<Item>>();
      const second = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockResolvedValueOnce(page([item(2)]));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      const refreshing = client.refresh();
      const loading = client.loadMoreSettled();
      const superseding = client.refresh();
      first.resolve(page([item(1)], "1"));
      second.resolve(page([item(1)], "1"));
      await Promise.all([refreshing, superseding]);
      expect((await loading).outcome).toBe("loaded");
    });

    it("stops waiting without fetching when the request it waits on is cancelled", async () => {
      const pending = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => pending.promise);
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      void client.refresh();
      const loading = client.loadMoreSettled();
      client.cancel();
      expect((await loading).outcome).toBe("skipped");
      expect(fetchPage).toHaveBeenCalledTimes(2);
      pending.resolve(page([item(1)], "1"));
    });

    it("does not retry on a client cancelled while its own first load was in flight", async () => {
      const pending = deferred<InboxPage<Item>>();
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockImplementationOnce(() => pending.promise);
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      const loading = client.loadMoreSettled();
      client.cancel();
      pending.resolve(page([item(2)]));
      expect((await loading).outcome).toBe("skipped");
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("reports failed without retrying a failed fetch", async () => {
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1)], "1"))
        .mockRejectedValueOnce(new Error("Offline"));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      expect((await client.loadMoreSettled()).outcome).toBe("failed");
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the existing range on a partial refresh failure and surfaces the error", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item(1)], "1"))
      .mockResolvedValueOnce(page([item(2)], "2"))
      .mockResolvedValueOnce(page([item(0)], "0"))
      .mockRejectedValueOnce(new Error("Offline"));
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    await client.loadMore();
    const previous = client.state.data;
    await client.refresh();
    expect(client.state.data).toBe(previous);
    expect(client.state.error).toBe(true);
    expect(client.state.refreshing).toBe(false);
  });

  it("invalidates requests on filter change or unmount", async () => {
    const pending = deferred<InboxPage<Item>>();
    const publish = vi.fn();
    const client = new InboxListClient<Item>(() => pending.promise, publish);
    const refreshing = client.refresh();
    client.cancel();
    publish.mockClear();
    pending.resolve(page([item(1)]));
    await refreshing;
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("InboxListClient optimistic removal", () => {
  const counted = (items: Item[]) => ({ ...page(items), statusCounts: { OPEN: 3, PENDING: 1, CLOSED: 5 } });
  const move = { from: "OPEN", to: "CLOSED" };

  it("drops the row and moves it between tab counts immediately", async () => {
    const client = new InboxListClient<Item>(vi.fn().mockResolvedValue(counted([item(1), item(2), item(3)])), vi.fn());
    await client.refresh();
    client.removeItem("2", move);
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1", "3"]);
    expect(client.state.data?.statusCounts).toEqual({ OPEN: 2, PENDING: 1, CLOSED: 6 });
  });

  it("ignores rows that are not in the list", async () => {
    const client = new InboxListClient<Item>(vi.fn().mockResolvedValue(counted([item(1)])), vi.fn());
    await client.refresh();
    expect(client.removeItem("missing", move)).toBeNull();
    expect(client.state.data).toEqual(counted([item(1)]));
  });

  it("rollback restores the row at its position and the original counts", async () => {
    const client = new InboxListClient<Item>(vi.fn().mockResolvedValue(counted([item(1), item(2), item(3)])), vi.fn());
    await client.refresh();
    client.removeItem("2", move)?.rollback();
    expect(client.state.data).toEqual(counted([item(1), item(2), item(3)]));
  });

  it("keeps the row hidden from a refresh already in flight until settled", async () => {
    const stale = deferred<InboxPage<Item>>();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(counted([item(1), item(2)]))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ...page([item(1)]), statusCounts: { OPEN: 1, PENDING: 1, CLOSED: 6 } });
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    const refreshing = client.refresh();
    const pending = client.removeItem("2", move);
    // The in-flight response was computed before the server saw the change.
    stale.resolve(counted([item(1), item(2)]));
    await refreshing;
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1"]);
    // ...and its pre-change counts must not undo the optimistic move.
    expect(client.state.data?.statusCounts).toEqual({ OPEN: 2, PENDING: 1, CLOSED: 6 });
    pending?.settle();
    await client.refresh();
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1"]);
    expect(client.state.data?.statusCounts.CLOSED).toBe(6);
  });

  it("rollback after a stale refresh still restores the original counts", async () => {
    const stale = deferred<InboxPage<Item>>();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(counted([item(1), item(2)]))
      .mockReturnValueOnce(stale.promise);
    const client = new InboxListClient<Item>(fetchPage, vi.fn());
    await client.refresh();
    const refreshing = client.refresh();
    const pending = client.removeItem("2", move);
    stale.resolve(counted([item(1), item(2)]));
    await refreshing;
    pending?.rollback();
    expect(client.state.data).toEqual(counted([item(1), item(2)]));
  });

  it("rollback after a failed save lets a later refresh show the row again", async () => {
    const client = new InboxListClient<Item>(vi.fn().mockResolvedValue(counted([item(1), item(2)])), vi.fn());
    await client.refresh();
    const pending = client.removeItem("2", move);
    pending?.rollback();
    await client.refresh();
    expect(client.state.data?.items.map((row) => row.id)).toEqual(["1", "2"]);
  });
});
