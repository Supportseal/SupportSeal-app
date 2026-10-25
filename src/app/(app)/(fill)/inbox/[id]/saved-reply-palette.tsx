"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconSearch } from "@tabler/icons-react";

import { cn } from "@/lib/cn";

/**
 * Saved-reply palette (FR-INBOX-02). One list, two entry points: typing `/`
 * at the start of a line in the composer (the textarea keeps focus and feeds
 * the query) and the "Saved" button (a search field in a popover). Both use
 * `usePaletteNav` + `SavedReplyResults`, so filtering, keyboard navigation
 * and Enter-to-insert behave identically.
 */
export type PaletteReply = {
  id: string;
  name: string;
  body: string;
  /** Empty = All products (Workspace-wide). */
  productNames: string[];
};

/** The `/query` token ending at the caret, only when `/` starts a line. */
export function findSlashToken(value: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\n)\/([^\s/]*)$/u.exec(value.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** Name matches first (prefix before substring), then body matches. */
export function filterSavedReplies(replies: PaletteReply[], query: string): PaletteReply[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return replies;
  const rank = (reply: PaletteReply) => {
    const name = reply.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (reply.body.toLowerCase().includes(needle)) return 2;
    return -1;
  };
  return replies
    .map((reply) => ({ reply, rank: rank(reply) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.reply);
}

export function usePaletteNav(replies: PaletteReply[], query: string) {
  const results = useMemo(() => filterSavedReplies(replies, query), [replies, query]);
  // The highlight resets to the first result whenever the query changes.
  const [nav, setNav] = useState({ query, index: 0 });
  const active = results.length === 0 ? 0 : Math.min(nav.query === query ? nav.index : 0, results.length - 1);

  /** Returns true when the key was consumed by the palette. */
  function handleKey(
    event: React.KeyboardEvent,
    actions: { onPick: (reply: PaletteReply) => void; onEscape?: () => void },
  ): boolean {
    if (event.nativeEvent.isComposing) return false;
    if (event.key === "Escape" && actions.onEscape) {
      event.preventDefault();
      actions.onEscape();
      return true;
    }
    if (results.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setNav({ query, index: (active + step + results.length) % results.length });
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      actions.onPick(results[active]);
      return true;
    }
    return false;
  }

  return {
    results,
    active,
    setActive: (index: number) => setNav({ query, index }),
    handleKey,
  };
}

export function savedReplyOptionId(listId: string, reply: PaletteReply) {
  return `${listId}-${reply.id}`;
}

export function SavedReplyResults({
  listId,
  results,
  active,
  onActivate,
  onPick,
}: {
  listId: string;
  results: PaletteReply[];
  active: number;
  onActivate: (index: number) => void;
  onPick: (reply: PaletteReply) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  if (results.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted">No matching saved replies</p>;
  }
  return (
    <ul id={listId} role="listbox" aria-label="Saved replies" className="max-h-72 overflow-y-auto">
      {results.map((reply, index) => (
        <li
          key={reply.id}
          id={savedReplyOptionId(listId, reply)}
          ref={index === active ? activeRef : undefined}
          role="option"
          aria-selected={index === active}
          // Keep focus in the textarea / search field while pointing.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => onActivate(index)}
          onClick={() => onPick(reply)}
          className={cn("cursor-pointer rounded-md px-2 py-2", index === active && "bg-hover")}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-heading">{reply.name}</span>
            <span className="shrink-0 text-xs text-muted">
              {reply.productNames.length > 0 ? reply.productNames.join(", ") : "All products"}
            </span>
          </span>
          <span className="block truncate text-xs text-muted">{reply.body}</span>
        </li>
      ))}
    </ul>
  );
}

function ManageHint({ canManage }: { canManage: boolean }) {
  return (
    <div className="px-2 py-3 text-sm">
      <p className="font-medium text-heading">No saved replies yet</p>
      {canManage ? (
        <Link href="/saved-replies" className="text-primary hover:underline">
          Manage saved replies
        </Link>
      ) : (
        <p className="text-muted">Ask an admin to add some.</p>
      )}
    </div>
  );
}

/** Saved-button entry point: the same results list behind a search field. */
export function SavedReplyPopoverBody({
  replies,
  canManage,
  onPick,
}: {
  replies: PaletteReply[];
  canManage: boolean;
  onPick: (reply: PaletteReply) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const nav = usePaletteNav(replies, query);

  if (replies.length === 0) return <ManageHint canManage={canManage} />;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-2">
        <IconSearch className="size-4 shrink-0 text-muted" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            nav.results[nav.active] ? savedReplyOptionId(listId, nav.results[nav.active]) : undefined
          }
          aria-label="Search saved replies"
          placeholder="Search saved replies…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => nav.handleKey(event, { onPick })}
          className="w-full bg-transparent text-sm text-heading placeholder:text-muted focus:outline-none"
        />
      </div>
      <SavedReplyResults
        listId={listId}
        results={nav.results}
        active={nav.active}
        onActivate={nav.setActive}
        onPick={onPick}
      />
    </div>
  );
}
