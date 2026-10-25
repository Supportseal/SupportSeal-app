import { describe, expect, it, vi } from "vitest";

import { InboxListClient, type InboxPage } from "@/lib/inbox-list-client";
import {
  nextConversationAfterClose,
  nextConversationAfterCloseLoading,
  noteConversationStatus,
  publishVisibleConversations,
  visibleConversations,
} from "@/lib/inbox-advance";

const row = (id: string, status: "OPEN" | "PENDING" | "CLOSED" = "OPEN") => ({ id, status });

describe("nextConversationAfterClose", () => {
  it("picks the row below the closed conversation", () => {
    expect(nextConversationAfterClose([row("a"), row("b"), row("c")], "a")).toBe("b");
    expect(nextConversationAfterClose([row("a"), row("b"), row("c")], "b")).toBe("c");
  });

  it("returns null when the closed conversation was last, so the caller shows the empty state", () => {
    expect(nextConversationAfterClose([row("a"), row("b"), row("c")], "c")).toBeNull();
  });

  it("skips rows that are already closed", () => {
    expect(nextConversationAfterClose([row("a"), row("b", "CLOSED"), row("c")], "a")).toBe("c");
    expect(nextConversationAfterClose([row("a"), row("b", "CLOSED"), row("c")], "b")).toBe("c");
  });

  it("keeps pending conversations eligible", () => {
    expect(nextConversationAfterClose([row("a"), row("b", "PENDING")], "a")).toBe("b");
  });

  it("returns null when nothing else remains", () => {
    expect(nextConversationAfterClose([row("a")], "a")).toBeNull();
    expect(nextConversationAfterClose([row("a"), row("b", "CLOSED")], "a")).toBeNull();
    expect(nextConversationAfterClose([], "a")).toBeNull();
  });

  it("returns null when the closed conversation is not in the list", () => {
    expect(nextConversationAfterClose([row("a"), row("b")], "zzz")).toBeNull();
  });
});

describe("visible conversation snapshot", () => {
  it("returns what the list pane last published", () => {
    publishVisibleConversations([row("a"), row("b")]);
    expect(visibleConversations().map((item) => item.id)).toEqual(["a", "b"]);
    publishVisibleConversations([]);
    expect(visibleConversations()).toEqual([]);
  });

  it("applies this tab's own status changes over a stale list, so a quick second Close skips the first", () => {
    publishVisibleConversations([row("a"), row("b"), row("c")]);
    noteConversationStatus("b", "CLOSED");
    expect(nextConversationAfterClose(visibleConversations(), "a")).toBe("c");
    noteConversationStatus("b", "OPEN");
    expect(nextConversationAfterClose(visibleConversations(), "a")).toBe("b");
    publishVisibleConversations([]);
  });

  it("drops an override once the refetched list reflects it", () => {
    publishVisibleConversations([row("a"), row("b")]);
    noteConversationStatus("b", "CLOSED");
    publishVisibleConversations([row("a"), row("b", "CLOSED")]);
    // A visitor message reopens b later; the list is authoritative again.
    publishVisibleConversations([row("a"), row("b")]);
    expect(nextConversationAfterClose(visibleConversations(), "a")).toBe("b");
    publishVisibleConversations([]);
  });
});

describe("nextConversationAfterCloseLoading", () => {
  const loaded = (...items: ReturnType<typeof row>[]) => ({ outcome: "loaded" as const, items });
  const next = (id: string) => ({ kind: "next", id });

  it("loads the next page when the closed row is the loaded tail", async () => {
    const loadMore = vi.fn().mockResolvedValue(loaded(row("a"), row("b"), row("c"), row("d")));
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("b")).toEqual(next("c"));
    expect(loadMore).toHaveBeenCalledTimes(1);
    publishVisibleConversations([]);
  });

  it("keeps loading while the fetched pages hold only closed rows", async () => {
    const loadMore = vi.fn()
      .mockResolvedValueOnce(loaded(row("a"), row("b"), row("c", "CLOSED")))
      .mockResolvedValueOnce(loaded(row("a"), row("b"), row("c", "CLOSED"), row("d")));
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("b")).toEqual(next("d"));
    expect(loadMore).toHaveBeenCalledTimes(2);
    publishVisibleConversations([]);
  });

  it("reports the closed one as last only once the list says it is exhausted", async () => {
    const loadMore = vi.fn().mockResolvedValue({ outcome: "exhausted", items: [row("a"), row("b")] });
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("b")).toEqual({ kind: "last" });
    expect(loadMore).toHaveBeenCalledTimes(1);
    publishVisibleConversations([]);
  });

  it.each(["skipped", "failed"] as const)("reports unavailable, not last, when the page load was %s", async (outcome) => {
    const loadMore = vi.fn().mockResolvedValue({ outcome, items: [row("a"), row("b")] });
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("b")).toEqual({ kind: "unavailable" });
    expect(loadMore).toHaveBeenCalledTimes(1);
    publishVisibleConversations([]);
  });

  it("still advances when a skipped load left a refreshed list with a next row", async () => {
    const loadMore = vi.fn().mockResolvedValue({ outcome: "skipped", items: [row("a"), row("b"), row("c")] });
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("b")).toEqual(next("c"));
    publishVisibleConversations([]);
  });

  it("does not load when a next row is already there or there are no more pages", async () => {
    const loadMore = vi.fn();
    publishVisibleConversations([row("a"), row("b")], loadMore);
    expect(await nextConversationAfterCloseLoading("a")).toEqual(next("b"));
    expect(loadMore).not.toHaveBeenCalled();
    publishVisibleConversations([row("a"), row("b")]);
    expect(await nextConversationAfterCloseLoading("b")).toEqual({ kind: "last" });
    publishVisibleConversations([]);
  });

  describe("against the list client", () => {
    type Item = { id: string; createdAt: string; status: "OPEN" | "PENDING" | "CLOSED" };
    const item = (id: number): Item => ({
      id: String(id), createdAt: new Date(100_000 + id * 1000).toISOString(), status: "OPEN",
    });
    const page = (items: Item[], nextCursor: string | null = null): InboxPage<Item> => ({
      items, nextCursor, statusCounts: { OPEN: 3 },
    });
    // Mirrors how the list pane publishes its client to the thread pane.
    const publishClient = (client: InboxListClient<Item>) => {
      const { data } = client.state;
      publishVisibleConversations(data?.items ?? [], data?.nextCursor
        ? () => client.loadMoreSettled()
        : null);
    };

    it("advances to the next page's row when a refresh is still in flight at Close", async () => {
      let release!: (value: InboxPage<Item>) => void;
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1), item(2)], "2"))
        .mockImplementationOnce(() => new Promise<InboxPage<Item>>((resolve) => { release = resolve; }))
        .mockResolvedValueOnce(page([item(3)]));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      publishClient(client);
      // The debounced refetch from a previous Close is still running.
      const refreshing = client.refresh();
      const advancing = nextConversationAfterCloseLoading("2");
      release(page([item(1), item(2)], "2"));
      await refreshing;
      expect(await advancing).toEqual(next("3"));
      publishVisibleConversations([]);
    });

    it("reports unavailable instead of an empty state when the next page cannot be fetched", async () => {
      const fetchPage = vi.fn()
        .mockResolvedValueOnce(page([item(1), item(2)], "2"))
        .mockRejectedValueOnce(new Error("Offline"));
      const client = new InboxListClient<Item>(fetchPage, vi.fn());
      await client.refresh();
      publishClient(client);
      expect(await nextConversationAfterCloseLoading("2")).toEqual({ kind: "unavailable" });
      publishVisibleConversations([]);
    });
  });
});
