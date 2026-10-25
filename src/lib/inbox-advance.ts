import type { LoadMoreOutcome } from "@/lib/inbox-list-client";

type ListedConversation = { id: string; status: "OPEN" | "PENDING" | "CLOSED" };

/**
 * The conversation to open after `closedId` leaves the agent's queue: the
 * next not-closed row below it in the list as currently shown. When the
 * closed one was last, `null` — the caller shows the empty state.
 */
export function nextConversationAfterClose(
  items: readonly ListedConversation[],
  closedId: string,
): string | null {
  const index = items.findIndex((item) => item.id === closedId);
  if (index === -1) return null;
  const isOpen = (item: ListedConversation) => item.status !== "CLOSED";
  return items.slice(index + 1).find(isOpen)?.id ?? null;
}

let visibleList: readonly ListedConversation[] = [];
type LoadMore = () => Promise<{ outcome: LoadMoreOutcome; items: readonly ListedConversation[] }>;

// Fetches the list's next page when more rows exist beyond the loaded ones.
let loadMoreVisible: LoadMore | null = null;
// Status changes made in this tab that the published list has not caught up
// with yet. The list lags behind them until its next refetch, so a quick second Close must not advance back to a row the
// agent has just closed.
const statusOverrides = new Map<string, ListedConversation["status"]>();

/** Published by the list pane so the thread pane can see "the current list". */
export function publishVisibleConversations(
  items: readonly ListedConversation[],
  loadMore: LoadMore | null = null,
) {
  visibleList = items;
  loadMoreVisible = loadMore;
  // Once the list shows a change, it is authoritative for that row again.
  for (const item of items) {
    if (statusOverrides.get(item.id) === item.status) statusOverrides.delete(item.id);
  }
}

export function noteConversationStatus(id: string, status: ListedConversation["status"]) {
  statusOverrides.set(id, status);
}

function withOverrides(items: readonly ListedConversation[]): readonly ListedConversation[] {
  return items.map((item) => {
    const status = statusOverrides.get(item.id);
    return status ? { ...item, status } : item;
  });
}

/** The published list with this tab's own status changes applied on top. */
export function visibleConversations(): readonly ListedConversation[] {
  return withOverrides(visibleList);
}

export type CloseAdvanceTarget =
  | { kind: "next"; id: string }
  // The closed one was last: the empty state is right.
  | { kind: "last" }
  // The next page could not be loaded, so whether a next one exists is unknown.
  | { kind: "unavailable" };

/**
 * Like `nextConversationAfterClose` on the published list, but when the
 * closed row is the loaded tail and the list has more pages, loads them until
 * a next row turns up. `last` is only reported once the list says it is
 * exhausted; a page that was skipped or failed to load is `unavailable`.
 */
export async function nextConversationAfterCloseLoading(closedId: string): Promise<CloseAdvanceTarget> {
  let items = visibleConversations();
  for (;;) {
    const next = nextConversationAfterClose(items, closedId);
    if (next) return { kind: "next", id: next };
    if (!loadMoreVisible) return { kind: "last" };
    const { outcome, items: loaded } = await loadMoreVisible();
    items = withOverrides(loaded);
    if (outcome === "loaded") continue;
    // The load may have been skipped behind a refresh that brought in a next row.
    const found = nextConversationAfterClose(items, closedId);
    if (found) return { kind: "next", id: found };
    return { kind: outcome === "exhausted" ? "last" : "unavailable" };
  }
}
