"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Step-4 waiting state: listens for the first conversation of the Product
 * (polling; the inbox stream serves agents, this page is pre-inbox).
 */
export function WaitingCard({ productId }: { productId: string }) {
  const [state, setState] = useState<"waiting" | "done">("waiting");
  const [firstLine, setFirstLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/inbox?status=ALL&product=${productId}`);
        if (!response.ok) return;
        const data = (await response.json()) as { items: Array<{ preview: string | null }> };
        if (!cancelled && data.items.length > 0) {
          setFirstLine(data.items[0]?.preview ?? null);
          setState("done");
        }
      } catch {
        // retry silently
      }
    };
    const timer = setInterval(poll, 4000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [productId]);

  if (state === "waiting") {
    return (
      <div role="status" className="rounded-lg border border-border bg-surface p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-heading">
          <span className="size-2 animate-pulse rounded-full bg-primary" aria-hidden />
          Waiting for your first message…
        </p>
        <p className="mt-1 text-xs text-muted">
          Send a chat from a page with your widget — it will appear here. Nothing arriving?
          Check the domain allowlist, or that the script is on the page.
        </p>
      </div>
    );
  }

  return (
    <div role="status" className="rounded-lg border border-success bg-success-label p-4">
      <p className="text-sm font-medium text-success">First message received</p>
      {firstLine ? <p className="mt-1 text-sm text-body">{firstLine}</p> : null}
      <Link
        href="/inbox"
        className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-contrast hover:bg-primary-dark"
      >
        Open it in your inbox
      </Link>
    </div>
  );
}
