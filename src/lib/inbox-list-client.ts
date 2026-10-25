type ListItem = { id: string; createdAt: string };
type StatusMove = { from: string; to: string };

export type InboxPage<T extends ListItem> = {
  items: T[];
  nextCursor: string | null;
  statusCounts: Record<string, number>;
};

/**
 * What a `loadMore()` call did. Only `exhausted` means the list has no more
 * rows; `skipped` (another request owned the client) and `failed` mean the
 * next page is simply not known.
 */
export type LoadMoreOutcome = "loaded" | "exhausted" | "skipped" | "failed";

type ListState<T extends ListItem> = {
  data: InboxPage<T> | null;
  error: boolean;
  loadingMore: boolean;
  refreshing: boolean;
};

/** Preserve server order and the first (newest fetched) copy of each row. */
export function reconcileInboxPages<T extends ListItem>(
  pages: InboxPage<T>[],
): InboxPage<T> {
  const items = new Map<string, T>();
  for (const page of pages) {
    for (const item of page.items) {
      if (!items.has(item.id)) items.set(item.id, item);
    }
  }
  return {
    items: [...items.values()],
    nextCursor: pages.at(-1)?.nextCursor ?? null,
    statusCounts: pages[0]?.statusCounts ?? {},
  };
}

function bumpCount(counts: Record<string, number>, status: string, by: number) {
  return status in counts ? { ...counts, [status]: Math.max(0, counts[status] + by) } : counts;
}

/** Shift one row between tab counts; `direction: -1` reverses the move. */
function applyMove(counts: Record<string, number>, move: StatusMove, direction: 1 | -1 = 1) {
  return bumpCount(bumpCount(counts, move.from, -direction), move.to, direction);
}

/** One request owner for both live refresh and pagination, scoped to filters. */
export class InboxListClient<T extends ListItem> {
  state: ListState<T> = {
    data: null, error: false, loadingMore: false, refreshing: false,
  };
  private request: AbortController | null = null;
  private idleWaiters: (() => void)[] = [];
  private cancellations = 0;
  /** Rows removed optimistically; kept out of fetched data until settled. */
  private readonly hidden = new Map<string, StatusMove>();

  constructor(
    private readonly fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<InboxPage<T>>,
    private readonly publish: (state: ListState<T>) => void,
  ) {}

  cancel() {
    this.request?.abort();
    this.cancellations += 1;
    this.release();
  }

  private release() {
    this.request = null;
    for (const resume of this.idleWaiters.splice(0)) resume();
  }

  /** Resolves once no request owns the client. A superseding refresh keeps it waiting. */
  private whenIdle() {
    return this.request
      ? new Promise<void>((resume) => this.idleWaiters.push(resume))
      : Promise.resolve();
  }

  private update(changes: Partial<ListState<T>>) {
    const { data } = changes;
    if (data && this.hidden.size) {
      // A response that still lists a hidden row predates the change, so its
      // counts do too; one that omits it already reflects the move.
      let { statusCounts } = data;
      for (const [id, move] of this.hidden) {
        if (!data.items.some((item) => item.id === id)) continue;
        statusCounts = applyMove(statusCounts, move);
      }
      changes = {
        ...changes,
        data: { ...data, statusCounts, items: data.items.filter((item) => !this.hidden.has(item.id)) },
      };
    }
    this.state = { ...this.state, ...changes };
    this.publish(this.state);
  }

  /**
   * Optimistically drop a row that is moving to another status, adjusting the
   * tab counts. The row stays hidden from refreshes (a fetch already in flight
   * would otherwise bring it back) until `settle()`; `rollback()` restores it
   * and the counts exactly where they were.
   */
  removeItem(id: string, move: StatusMove) {
    const data = this.state.data;
    const index = data?.items.findIndex((item) => item.id === id) ?? -1;
    if (!data || index < 0) return null;
    const removed = data.items[index];
    // Hiding the row reuses update()'s projection to drop it and move the
    // counts, exactly as it does for a stale in-flight response.
    this.hidden.set(id, move);
    this.update({ data });
    return {
      settle: () => {
        this.hidden.delete(id);
      },
      rollback: () => {
        this.hidden.delete(id);
        const current = this.state.data;
        if (!current || current.items.some((item) => item.id === id)) return;
        const items = [...current.items];
        items.splice(Math.min(index, items.length), 0, removed);
        this.update({
          data: {
            ...current,
            items,
            statusCounts: applyMove(current.statusCounts, move, -1),
          },
        });
      },
    };
  }

  async refresh() {
    this.request?.abort();
    const controller = new AbortController();
    this.request = controller;
    const previous = this.state.data;
    const oldest = previous?.items.at(-1);
    this.update({ refreshing: true, loadingMore: false });
    try {
      const pages: InboxPage<T>[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let refreshed: InboxPage<T>;
      do {
        const page = await this.fetchPage(cursor, controller.signal);
        if (this.request !== controller) return;
        pages.push(page);
        refreshed = reconcileInboxPages(pages);
        // Walk the previously loaded range. The list is ordered by creation
        // (createdAt, id) and a row never moves, so the range is covered once
        // the former tail reappears or a row created after it is reached.
        // Rows that left the filters shift later rows up and a reopened old
        // ticket slots in mid-list; the walk still reaches the tail either
        // way, and refetching it drops rows that no longer match. A fixed
        // page cap would drop loaded rows after a larger burst.
        const tail = page.items.at(-1);
        if (!page.nextCursor || !oldest || !tail || (
          page.items.some((item) => item.id === oldest.id) ||
          Date.parse(tail.createdAt) > Date.parse(oldest.createdAt)
        )) break;
        if (cursors.has(page.nextCursor)) throw new Error("Inbox cursor did not advance");
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (true);
      this.update({ data: refreshed, error: false });
    } catch {
      if (this.request === controller) this.update({ error: true });
    } finally {
      if (this.request === controller) {
        this.release();
        this.update({ refreshing: false });
      }
    }
  }

  async loadMore(): Promise<LoadMoreOutcome> {
    const previous = this.state.data;
    // Synchronous ownership prevents double clicks and pagination during a
    // refresh, even before React has rendered the disabled button.
    if (this.request || !previous) return "skipped";
    if (!previous.nextCursor) return "exhausted";
    const controller = new AbortController();
    this.request = controller;
    this.update({ loadingMore: true });
    let outcome: LoadMoreOutcome = "skipped";
    try {
      const page = await this.fetchPage(previous.nextCursor, controller.signal);
      if (this.request === controller) {
        this.update({ data: reconcileInboxPages([previous, page]), error: false });
        outcome = "loaded";
      }
    } catch {
      if (this.request === controller) {
        this.update({ error: true });
        outcome = "failed";
      }
    } finally {
      if (this.request === controller) {
        this.release();
        this.update({ loadingMore: false });
      }
    }
    return outcome;
  }

  /**
   * `loadMore()` for callers that need the next page rather than a click's
   * best effort: a request already in flight is waited out and the load
   * retried once, and the rows are returned as the list then holds them.
   */
  async loadMoreSettled(): Promise<{ outcome: LoadMoreOutcome; items: readonly T[] }> {
    const cancellations = this.cancellations;
    let outcome = await this.loadMore();
    if (outcome === "skipped") {
      await this.whenIdle();
      // A cancelled client (filters changed, unmounted) must not fetch again.
      if (cancellations === this.cancellations) outcome = await this.loadMore();
    }
    return { outcome, items: this.state.data?.items ?? [] };
  }
}
