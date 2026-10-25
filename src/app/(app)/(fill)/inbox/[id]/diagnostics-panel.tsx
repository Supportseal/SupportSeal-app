"use client";

import { useState } from "react";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { IconCheck, IconCopy, IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/cn";

/**
 * Agent-facing diagnostics (docs/design/diagnostics.md "Agent view").
 * Everything here is untrusted text, rendered as text only — no HTML, no
 * Markdown, no auto-linking (including stack file URLs).
 */

export type DiagEventView = {
  kind: "js_error" | "promise_rejection" | "warning" | "network";
  name?: string;
  message?: string;
  frames?: Array<{ fn: string; file: string; line: number; col: number }>;
  method?: string;
  url?: string;
  status?: number;
  lastSeen: number;
  count: number;
};

export type DiagSnapshotView = {
  id: string;
  messageId: string;
  createdAt: string;
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
  droppedCount: number;
  environment: {
    pageUrl: string;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
    appVersion: string;
    browser: string;
    os: string;
  };
  events: DiagEventView[];
};

const KIND_META = {
  js_error: { label: "Error", color: "danger" as const },
  promise_rejection: { label: "Error", color: "danger" as const },
  warning: { label: "Warning", color: "warning" as const },
  network: { label: "Network", color: "secondary" as const },
};

function plural(n: number, singular: string, pluralWord?: string) {
  return `${n} ${n === 1 ? singular : (pluralWord ?? `${singular}s`)}`;
}

/** "Diagnostics · 2 errors · 1 failed request" (zero counts omitted). */
export function chipLabel(snapshot: {
  errorCount: number;
  warningCount: number;
  networkFailureCount: number;
}): string {
  const parts: string[] = [];
  if (snapshot.errorCount > 0) parts.push(plural(snapshot.errorCount, "error"));
  if (snapshot.warningCount > 0) parts.push(plural(snapshot.warningCount, "warning"));
  if (snapshot.networkFailureCount > 0) {
    parts.push(plural(snapshot.networkFailureCount, "failed request"));
  }
  return `Diagnostics · ${parts.length > 0 ? parts.join(" · ") : "no errors"}`;
}

export function stackText(frames: Array<{ fn: string; file: string; line: number; col: number }>) {
  return frames
    .map((frame) => `at ${frame.fn || "<anonymous>"} (${frame.file}:${frame.line}:${frame.col})`)
    .join("\n");
}

function eventTitle(event: DiagEventView): string {
  if (event.kind === "network") return `${event.method} ${event.url} → ${event.status}`;
  return event.message ?? "";
}

function relativeToMessage(eventLastSeen: number, messageAt: string): string {
  const diffSeconds = Math.max(0, Math.round((new Date(messageAt).getTime() - eventLastSeen) / 1000));
  if (diffSeconds < 120) return `${diffSeconds}s before`;
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 120) return `${minutes}m before`;
  return `${Math.round(minutes / 60)}h before`;
}

export function snapshotToText(snapshot: DiagSnapshotView): string {
  const lines = [
    `Diagnostics snapshot — captured with message at ${snapshot.createdAt}`,
    `Browser: ${snapshot.environment.browser} · OS: ${snapshot.environment.os}`,
    `Viewport: ${snapshot.environment.viewportWidth} × ${snapshot.environment.viewportHeight} @${snapshot.environment.devicePixelRatio}x`,
    `App version: ${snapshot.environment.appVersion}`,
    `Page: ${snapshot.environment.pageUrl}`,
    `${snapshot.errorCount} errors · ${snapshot.warningCount} warnings · ${snapshot.networkFailureCount} failed requests` +
      (snapshot.droppedCount > 0 ? ` (${snapshot.droppedCount} more events not included)` : ""),
    "",
  ];
  for (const event of [...snapshot.events].sort((a, b) => b.lastSeen - a.lastSeen)) {
    const repeat = event.count > 1 ? ` ×${event.count}` : "";
    if (event.kind === "network") {
      lines.push(`[network] ${eventTitle(event)}${repeat}`);
    } else {
      const name = event.name ? `${event.name}: ` : "";
      lines.push(`[${KIND_META[event.kind].label.toLowerCase()}] ${name}${event.message ?? ""}${repeat}`);
      if (event.frames && event.frames.length > 0) {
        for (const line of stackText(event.frames).split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
  }
  return lines.join("\n");
}

function CopyAsTextButton({ snapshot }: { snapshot: DiagSnapshotView }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(snapshotToText(snapshot));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
      {copied ? "Copied" : "Copy as text"}
    </Button>
  );
}

function EnvironmentList({ snapshot }: { snapshot: DiagSnapshotView }) {
  return (
    <dl className="mt-1.5 space-y-1.5 text-sm">
      <div className="flex justify-between gap-2">
        <dt className="text-muted">Browser</dt>
        <dd className="min-w-0 break-all text-right text-body">{snapshot.environment.browser}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted">OS</dt>
        <dd className="min-w-0 break-all text-right text-body">{snapshot.environment.os}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted">Viewport</dt>
        <dd className="text-right text-body">
          {snapshot.environment.viewportWidth} × {snapshot.environment.viewportHeight} @
          {snapshot.environment.devicePixelRatio}x
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted">App version</dt>
        <dd className="min-w-0 break-all text-right text-body">{snapshot.environment.appVersion}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted">Page</dt>
        <dd className="min-w-0 break-all text-right text-body">{snapshot.environment.pageUrl}</dd>
      </div>
    </dl>
  );
}

export function SnapshotSheet({
  snapshot,
  onOpenChange,
}: {
  snapshot: DiagSnapshotView | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!snapshot) return null;
  const events = [...snapshot.events].sort((a, b) => b.lastSeen - a.lastSeen);
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[28rem] gap-0 overflow-y-auto p-4">
        <SheetTitle>Diagnostics</SheetTitle>
        <SheetDescription className="text-xs text-muted">
          Captured with the message at {format(new Date(snapshot.createdAt), "d MMM yyyy, p")}
        </SheetDescription>
        <div className="mt-3">
          <EnvironmentList snapshot={snapshot} />
          <p className="mt-3 text-xs text-muted">
            {plural(snapshot.errorCount, "error")} · {plural(snapshot.warningCount, "warning")} ·{" "}
            {plural(snapshot.networkFailureCount, "failed request")}
            {snapshot.droppedCount > 0
              ? ` · ${snapshot.droppedCount} more ${snapshot.droppedCount === 1 ? "event" : "events"} not included`
              : ""}
          </p>
        </div>
        <ul className="mt-4 space-y-3">
          {events.map((event, index) => (
            <SnapshotEvent key={index} event={event} messageAt={snapshot.createdAt} />
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted">
            Values that look like secrets, emails or tokens were removed.
          </p>
          <CopyAsTextButton snapshot={snapshot} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SnapshotEvent({ event, messageAt }: { event: DiagEventView; messageAt: string }) {
  const [stackOpen, setStackOpen] = useState(false);
  const frames = event.frames;
  const hasStack = frames !== undefined && frames.length > 0;
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Badge variant="light" color={KIND_META[event.kind].color}>
          {KIND_META[event.kind].label}
        </Badge>
        <span className="text-xs text-muted">{relativeToMessage(event.lastSeen, messageAt)}</span>
        {event.count > 1 ? (
          <span className="text-xs text-muted" title="Repeat count">
            ×{event.count}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 break-all text-sm text-heading">{eventTitle(event)}</p>
      {event.kind !== "network" && event.name ? (
        <p className="text-xs text-muted">{event.name}</p>
      ) : null}
      {hasStack ? (
        <>
          <button
            type="button"
            aria-expanded={stackOpen}
            onClick={() => setStackOpen((open) => !open)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <IconChevronDown
              className={cn("size-3.5 transition-transform", stackOpen && "rotate-180")}
            />
            {stackOpen ? "Hide stack" : "Show stack"}
          </button>
          {stackOpen ? (
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-xs text-body" tabIndex={0}>
              {stackText(frames)}
            </pre>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/**
 * Context panel section (placed after "Developer context"): latest snapshot's
 * environment, counts, and a list of earlier snapshots in this Conversation.
 */
export function DiagnosticsSection({
  snapshots,
  hasExpired,
  onOpen,
}: {
  snapshots: DiagSnapshotView[];
  hasExpired: boolean;
  onOpen: (snapshot: DiagSnapshotView) => void;
}) {
  // Snapshots arrive oldest-first: the latest is the last, earlier ones are
  // listed newest-first below it.
  const latest = snapshots[snapshots.length - 1];
  const earlier = snapshots.slice(0, -1).reverse();
  return (
    <section>
      <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">
        Diagnostics
      </h3>
      {snapshots.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted">
          {hasExpired
            ? "Diagnostics from this conversation have expired (kept 30 days)."
            : "No diagnostics yet. They're attached when the visitor sends a message."}
        </p>
      ) : (
        <>
          <div className="mt-1.5">
            <EnvironmentList snapshot={latest} />
            <p className="mt-2 text-xs text-muted">
              {latest.errorCount + latest.warningCount + latest.networkFailureCount === 0
                ? "No errors captured"
                : [
                    latest.errorCount > 0 ? plural(latest.errorCount, "error") : null,
                    latest.warningCount > 0 ? plural(latest.warningCount, "warning") : null,
                    latest.networkFailureCount > 0
                      ? plural(latest.networkFailureCount, "failed request")
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}{" "}
              — captured with message at {format(new Date(latest.createdAt), "p")}
              {latest.droppedCount > 0
                ? ` (${latest.droppedCount} more ${latest.droppedCount === 1 ? "event" : "events"} not included)`
                : ""}
            </p>
            <Button
              type="button"
              variant="text"
              size="xs"
              className="mt-1 -ms-2"
              onClick={() => onOpen(latest)}
            >
              View snapshot
            </Button>
          </div>
          {earlier.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {earlier.map((snapshot) => (
                <li key={snapshot.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-primary hover:bg-hover hover:underline"
                    onClick={() => onOpen(snapshot)}
                  >
                    {chipLabel(snapshot)} · {format(new Date(snapshot.createdAt), "p")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Small secondary chip under a customer message bubble. */
export function DiagnosticsChip({
  snapshot,
  onOpen,
}: {
  snapshot: DiagSnapshotView;
  onOpen: (snapshot: DiagSnapshotView) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(snapshot)}
      className={cn(
        "mt-1 inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5",
        "text-xs text-body hover:bg-hover",
      )}
      aria-label={`Diagnostics for this message: ${[
        snapshot.errorCount > 0 ? plural(snapshot.errorCount, "error") : null,
        snapshot.warningCount > 0 ? plural(snapshot.warningCount, "warning") : null,
        snapshot.networkFailureCount > 0 ? plural(snapshot.networkFailureCount, "failed request") : null,
      ]
        .filter(Boolean)
        .join(", ") || "no errors"}`}
    >
      {chipLabel(snapshot)}
    </button>
  );
}
