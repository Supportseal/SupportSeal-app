"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { IconExternalLink } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";

/**
 * Developer context panel section (FR-CTX-01, docs/design/conversation-view.md):
 * well-known keys first, values as text only (never HTML), admin links only
 * when an absolute http(s) URL, page URL recorded by the widget labelled as
 * such. All values are untrusted and rendered as text.
 */
const LINKABLE_KEYS = ["adminUrl", "adminurl", "admin_url"];

function isLinkableKey(key: string): boolean {
  return LINKABLE_KEYS.includes(key);
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

const KEY_LABELS: Record<string, string> = {
  accountId: "Account ID",
  account: "Account",
  plan: "Plan",
  appVersion: "App version",
  buildVersion: "Build version",
  version: "Version",
  page: "Page",
  pageUrl: "Page",
  adminUrl: "Admin link",
};

function latestUpdatedAt(
  entries: Array<{ updatedAt: string | null }>,
): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    const stamp = entry.updatedAt;
    if (stamp && (!latest || stamp > latest)) latest = stamp;
  }
  return latest;
}

const subscribeNoop = () => () => {};

export function ContextSection({
  productName,
  entries,
}: {
  productName: string;
  entries: Array<{ key: string; value: string; updatedAt: string | null }>;
}) {
  const updatedAt = latestUpdatedAt(entries);
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  return (
    <section>
      <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">
        Context from {productName}
      </h3>
      {entries.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted">
          No context sent. Use <code className="font-mono">identify()</code> and{" "}
          <code className="font-mono">context()</code> in your app to see account details here.
        </p>
      ) : (
        <>
          {updatedAt && mounted ? (
            <p className="mt-1 text-xs text-muted">
              updated {formatDistanceToNowStrict(new Date(updatedAt))} ago
            </p>
          ) : null}
          <dl className="mt-1.5 space-y-1.5">
            {entries.map((entry) => {
              const url = isLinkableKey(entry.key) ? safeUrl(entry.value) : null;
              return (
                <div key={entry.key} className="flex items-start justify-between gap-2 text-sm">
                  <dt className="shrink-0 text-muted">
                    {KEY_LABELS[entry.key] ?? entry.key}
                    {entry.key === "pageUrl" ? (
                      <span className="block text-[0.625rem]">recorded by widget</span>
                    ) : null}
                  </dt>
                  <dd className="min-w-0 break-all text-right text-body">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {new URL(url).hostname}
                        <IconExternalLink className="size-3" />
                      </a>
                    ) : (
                      entry.value
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </section>
  );
}
