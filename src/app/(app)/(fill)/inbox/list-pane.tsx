"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isToday, format } from "date-fns";
import { toast } from "sonner";
import {
  IconCircleCheck,
  IconMail,
  IconMessageCircle,
  IconSearch,
  IconX,
} from "@tabler/icons-react";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { ProductMark } from "@/components/product-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatTicketRef } from "@/lib/ticket";
import {
  closeExitDelay,
  nextConversationAfterCloseLoading,
  noteConversationStatus,
  publishVisibleConversations,
} from "@/lib/inbox-advance";
import { InboxListClient } from "@/lib/inbox-list-client";
import { connectInboxStream } from "@/lib/inbox-stream-client";
import { broadcastNotifyKick } from "@/lib/notifications/client";

import { setStatusAction } from "./actions";

type ConversationItem = {
  id: string;
  ticketNumber: number;
  status: "OPEN" | "PENDING" | "CLOSED";
  channel: "CHAT" | "EMAIL";
  subject: string | null;
  createdAt: string;
  lastMessageAt: string;
  product: { id: string; name: string; primaryColor: string };
  contact: { id: string; email: string | null; name: string | null };
  preview: string | null;
  tags: { id: string; name: string }[];
};

type InboxResponse = {
  items: ConversationItem[];
  nextCursor: string | null;
  statusCounts: Record<string, number>;
};

const STATUS_TABS = [
  { id: "OPEN", label: "Open" },
  { id: "PENDING", label: "Pending" },
  { id: "CLOSED", label: "Closed" },
] as const;

function inboxListQuery(filters: { status: string; product: string; q: string; cursor?: string }) {
  const params = new URLSearchParams();
  if (!filters.q) params.set("status", filters.status);
  if (filters.product) params.set("product", filters.product);
  if (filters.q) params.set("q", filters.q);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return `/api/inbox?${params.toString()}`;
}

export function visitorLabel(contact: { id: string; email: string | null; name: string | null }) {
  if (contact.name?.trim()) return contact.name.trim();
  if (contact.email) return contact.email;
  return `Visitor ${(contact.id.replace(/[^a-z0-9]/gi, "").slice(-4) || "0000").toUpperCase()}`;
}

/** Compact list timestamp: "now", "12m", "3h", "Tue", "27 Oct". */
function relativeTime(iso: string) {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (isToday(date)) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return format(date, "EEE");
  return format(date, "d MMM");
}

export function ListPane() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = pathname.startsWith("/inbox/") ? pathname.split("/")[2] : null;

  const status = (searchParams.get("status") ?? "OPEN").toUpperCase();
  const product = searchParams.get("product") ?? "";
  const q = searchParams.get("q") ?? "";

  const searchInputRef = useRef<HTMLInputElement>(null);
  const [listState, setListState] = useState({
    data: null as InboxResponse | null,
    error: false,
    loadingMore: false,
    refreshing: false,
  });
  const { data, error, loadingMore, refreshing } = listState;
  const clientRef = useRef<InboxListClient<ConversationItem> | null>(null);
  const filtersRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      const filters = inboxListQuery({ status, product, q });
      if (filtersRef.current !== filters || !clientRef.current) {
        clientRef.current?.cancel();
        filtersRef.current = filters;
        clientRef.current = new InboxListClient(async (cursor, signal) => {
          const response = await fetch(inboxListQuery({ status, product, q, cursor }), { signal });
          if (!response.ok) throw new Error("Couldn't load conversations");
          return (await response.json()) as InboxResponse;
        }, setListState);
      }
      void clientRef.current.refresh();
    });
    return () => {
      disposed = true;
      clientRef.current?.cancel();
    };
  }, [status, product, q, pathname]);

  // Let the thread pane see the list as shown (for advancing after Close).
  useEffect(() => {
    publishVisibleConversations(data?.items ?? [], data?.nextCursor
      ? async () => (await clientRef.current?.loadMoreSettled()) ?? { outcome: "skipped", items: [] }
      : null);
    return () => publishVisibleConversations([], null);
  }, [data]);

  // Realtime: refetch the list (debounced) when a conversation in this
  // Workspace changes (ADR-0003 SSE; refetch-on-event keeps it correct even
  // across processes).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void clientRef.current?.refresh(), 400);
    };
    const disconnect = connectInboxStream({
      onConversation: () => {
        broadcastNotifyKick();
        scheduleRefetch();
      },
      // Back after a dropped stream: anything may have changed meanwhile.
      onResync: scheduleRefetch,
    });
    return () => {
      disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const closeConversation = async (item: ConversationItem, exited: Promise<void> = Promise.resolve()) => {
    const client = clientRef.current;
    if (!client) return;
    // Closing the open thread moves on to the next one in this queue, like the
    // header's Close; the target is picked before the row leaves the list.
    const advanceTarget = item.id === selectedId ? await nextConversationAfterCloseLoading(item.id) : null;
    const advancePath =
      advanceTarget?.kind === "next" ? `/inbox/${advanceTarget.id}` : advanceTarget?.kind === "last" ? "/inbox" : null;
    // The save starts now; the row's exit animation only times the removal.
    const saved = (async () => {
      try {
        return (await setStatusAction({ conversationId: item.id, status: "CLOSED" })).error;
      } catch {
        return "Couldn't close the conversation. Check your connection and try again.";
      }
    })();
    await exited;
    // The filters may have changed during the awaits above, swapping in a new
    // client; only the live one gets the optimistic removal. A stale one still
    // closes the conversation, and the refresh below corrects the list.
    const stale = clientRef.current !== client;
    const pending = stale ? null : client.removeItem(item.id, { from: item.status, to: "CLOSED" });
    if (!stale && !pending) return;
    // The filters may change while the save is in flight, which swaps in a new
    // client; an orphaned one must never publish its stale-filter rows.
    const syncAfterMove = () => {
      void clientRef.current?.refresh();
      if (item.id === selectedId) router.refresh();
    };
    const error = await saved;
    if (error) {
      if (clientRef.current === client) pending?.rollback();
      else pending?.settle();
      toast.error(error);
      return;
    }
    pending?.settle();
    track("conversation_status_changed", { status: "closed", from: "list" });
    noteConversationStatus(item.id, "CLOSED");
    toast("Conversation closed", {
      action: {
        label: "Undo",
        onClick: () => {
          void setStatusAction({ conversationId: item.id, status: item.status })
            .then((result) => result.error)
            .catch(() => "Couldn't undo. Check your connection and try again.")
            .then((undoError) => {
              if (undoError) {
                toast.error(undoError);
                return;
              }
              noteConversationStatus(item.id, item.status);
              // Like the header's Undo: only pull the agent back if they are
              // still where Close left them.
              if (advancePath && window.location.pathname === advancePath) {
                void clientRef.current?.refresh();
                router.push(`/inbox/${item.id}${searchParams.size ? `?${searchParams.toString()}` : ""}`);
              } else {
                syncAfterMove();
              }
            });
        },
      },
    });
    if (advancePath && window.location.pathname === `/inbox/${item.id}`) {
      const query = searchParams.size ? `?${searchParams.toString()}` : "";
      void clientRef.current?.refresh();
      router.push(`${advancePath}${query}`);
    } else {
      syncAfterMove();
    }
  };

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`/inbox${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const value = (searchInputRef.current?.value ?? "").trim();
      updateParams((params) => {
        if (value) params.set("q", value);
        else params.delete("q");
      });
    }
    if (event.key === "Escape") {
      if (searchInputRef.current) searchInputRef.current.value = "";
      if (q) updateParams((params) => params.delete("q"));
    }
  };

  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col border-e border-border bg-surface lg:w-[22.5rem] xl:w-[22.5rem]",
        selectedId && "hidden lg:flex",
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate text-sm font-medium text-heading">
          {product ? "Product scope" : "All Products"}
        </span>
        {product ? (
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-heading"
            aria-label="Show all Products"
            onClick={() =>
              updateParams((params) => {
                params.delete("product");
              })
            }
          >
            <IconX className="size-4" />
          </button>
        ) : null}
        <span className="ms-auto text-xs text-muted">{data?.items.length ?? 0}</span>
      </div>

      <div className="shrink-0 px-3 py-2">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchInputRef}
            key={q}
            type="search"
            defaultValue={q}
            onKeyDown={onSearchKeyDown}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-8 w-full rounded-md border border-border-strong bg-surface ps-8 pe-2 text-sm text-heading placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary"
          />
        </div>
      </div>

      {q ? (
        <div className="flex shrink-0 items-center gap-2 px-3 pb-2 text-xs text-muted">
          <span>
            Results for <strong className="text-heading">{q}</strong>
            {data ? ` · ${data.items.length}` : ""}
          </span>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => updateParams((params) => params.delete("q"))}
          >
            Clear
          </button>
        </div>
      ) : (
        <div
          className="flex shrink-0 gap-1 border-b border-border px-2"
          role="tablist"
          aria-label="Conversation status"
        >
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={status === tab.id}
              onClick={() => updateParams((params) => params.set("status", tab.id))}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm transition-colors",
                status === tab.id
                  ? "border-primary font-medium text-heading"
                  : "border-transparent text-body hover:text-heading",
              )}
            >
              {tab.label}
              <span className="text-xs text-muted">
                {data?.statusCounts[tab.id] ?? ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-sm text-danger">
            Couldn&apos;t load conversations.{" "}
            <button type="button" className="text-primary hover:underline" onClick={() => void clientRef.current?.refresh()}>
              Retry
            </button>
          </div>
        ) : null}
        {!data ? (error ? null : (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        )) : data.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            {q
              ? `No conversations match "${q}".`
              : `No ${status.toLowerCase()} conversations.`}
          </p>
        ) : (
          <>
            <ul aria-label="Conversations">
              {data.items.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  query={q}
                  onClose={closeConversation}
                />
              ))}
            </ul>
            {data.nextCursor ? (
              <div className="p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void clientRef.current?.loadMore()}
                  disabled={loadingMore || refreshing}
                >
                  {loadingMore ? <Spinner size={14} /> : null}
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Up to two initials for the contact avatar; "?" for anonymous visitors. */
function contactInitials(contact: ConversationItem["contact"]) {
  const name = contact.name?.trim();
  if (name) {
    const parts = name.split(/\s+/u).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
  }
  if (contact.email) return contact.email[0]!.toUpperCase();
  return "?";
}

function ConversationRow({
  item,
  selected,
  query,
  onClose,
}: {
  item: ConversationItem;
  selected: boolean;
  query: string;
  onClose: (item: ConversationItem, exited: Promise<void>) => void;
}) {
  const searchParams = useSearchParams();
  const [collapsing, setCollapsing] = useState(false);
  const params = new URLSearchParams(searchParams.toString());
  if (query) params.set("q", query);
  const closable = item.status !== "CLOSED";
  const label = visitorLabel(item.contact);
  // Email threads lead with their subject; chats lead with the latest message.
  const headline = item.subject ?? item.preview ?? "No messages yet";
  const preview = item.subject ? item.preview : null;
  const ChannelIcon = item.channel === "EMAIL" ? IconMail : IconMessageCircle;

  return (
    <li className={cn("group relative", collapsing && "row-collapse")}>
      <Link
        href={`/inbox/${item.id}${params.size ? `?${params.toString()}` : ""}`}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex gap-3 border-b border-border px-4 py-3.5 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
          selected
            ? "bg-primary-label shadow-[inset_3px_0_0_var(--vx-primary)]"
            : "hover:bg-hover",
        )}
      >
        <span className="relative mt-0.5 size-9 shrink-0 self-start" aria-hidden>
          <span className="flex size-9 items-center justify-center rounded-full bg-secondary-label text-xs font-semibold text-body ring-1 ring-inset ring-border">
            {contactInitials(item.contact)}
          </span>
          <ProductMark
            name={item.product.name}
            color={item.product.primaryColor}
            className="absolute -end-1 -bottom-1 size-4 rounded-[0.3125rem] text-[0.5625rem] ring-2 ring-surface"
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-heading">{label}</span>
            <time
              className="shrink-0 text-xs tabular-nums text-muted"
              title={new Date(item.lastMessageAt).toLocaleString()}
              dateTime={item.lastMessageAt}
            >
              {relativeTime(item.lastMessageAt)}
            </time>
          </span>

          <span className={cn("mt-0.5 block text-sm text-heading", preview ? "truncate font-medium" : "line-clamp-2 text-body")}>
            {headline}
          </span>
          {preview ? <span className="mt-0.5 block truncate text-sm text-muted">{preview}</span> : null}

          <span className={cn("mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted", closable && "pe-9")}>
            <ChannelIcon className="size-3.5 shrink-0" aria-label={item.channel === "EMAIL" ? "Email" : "Chat"} />
            <span className="min-w-0 truncate">{item.product.name}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatTicketRef(item.ticketNumber)}</span>
            {item.tags.slice(0, 2).map((tag) => (
              <Badge
                key={tag.id}
                variant="light"
                color="secondary"
                pill={false}
                className="max-w-24 shrink-0 truncate px-1.5 py-0 text-[0.6875rem]"
              >
                {tag.name}
              </Badge>
            ))}
            {item.tags.length > 2 ? <span className="shrink-0">+{item.tags.length - 2}</span> : null}
            {/* The tabs already say the status; search results mix them. */}
            {query && item.status !== "OPEN" ? (
              <Badge
                variant="light"
                color={item.status === "PENDING" ? "warning" : "secondary"}
                pill={false}
                className="ms-auto shrink-0 px-1.5 py-0 text-[0.6875rem]"
              >
                {item.status.toLowerCase()}
              </Badge>
            ) : null}
          </span>
        </span>
      </Link>
      {closable ? (
        // A sibling of the link (a button inside an anchor is invalid HTML).
        // Always shown on touch screens; revealed on hover or focus where a
        // pointer can hover.
        <button
          type="button"
          aria-label={`Close conversation with ${label}`}
          title="Close conversation"
          className="absolute end-1.5 bottom-1.5 flex size-9 items-center justify-center rounded-md text-muted transition hover:bg-surface hover:text-success hover:shadow-sm focus-visible:outline-2 focus-visible:outline-primary [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100"
          onClick={(event) => {
            // Never let the click reach the row (and open the thread).
            event.preventDefault();
            event.stopPropagation();
            setCollapsing(true);
            const exited = closeExitDelay();
            void Promise.resolve(onClose(item, exited)).finally(() => setCollapsing(false));
          }}
        >
          <IconCircleCheck className="size-[1.125rem]" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
