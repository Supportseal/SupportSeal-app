"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/format";
import { allowRejectedHostAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

export type InstallationCardProps = {
  productId: string;
  isAdmin: boolean;
  /** ISO instant the lists were read at; relative times derive from it. */
  now: string;
  loaded: { host: string; lastSeenAt: string }[];
  rejected: { host: string; lastSeenAt: string; sibling: string | null }[];
};

function AllowForm({
  productId,
  host,
  sibling,
}: {
  productId: string;
  host: string;
  sibling: string | null;
}) {
  const [state, formAction, pending] = useActionState(allowRejectedHostAction, initialState);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="host" value={host} />
      <div className="flex items-center gap-3">
        {sibling ? (
          <label className="flex items-center gap-1.5 text-xs text-body">
            <input type="checkbox" name="includeSibling" defaultChecked className="size-3.5 accent-[var(--vx-primary)]" />
            <span>
              Also allow <span className="font-mono">{sibling}</span>
            </span>
          </label>
        ) : null}
        <Button type="submit" size="xs" variant="outline" disabled={pending} aria-label={`Allow ${host}`}>
          {pending ? "Allowing…" : "Allow"}
        </Button>
      </div>
      {state.error ? <p className="text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}

/**
 * Installation panel (issue #192): where the widget config was last loaded
 * from, and hostnames that were refused, with an Allow button. Hostname and
 * time only - no visitor data is recorded.
 */
export function InstallationCard({ productId, isAdmin, now, loaded, rejected }: InstallationCardProps) {
  return (
    <Card id="installation" className="scroll-mt-6">
      <CardContent className="space-y-5 p-6">
        <div>
          <h3 className="text-lg font-medium text-heading">Installation</h3>
          <p className="mt-1 text-sm text-muted">
            Hostnames the widget loaded from and hostnames it was refused on. Only the hostname and
            time are kept (no visitor data), at most once an hour per host, for up to 50 hosts.
          </p>
        </div>

        <section aria-labelledby="installation-loaded" className="space-y-2">
          <h4 id="installation-loaded" className="text-sm font-medium text-heading">
            Loaded from
          </h4>
          {loaded.length === 0 ? (
            <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted">
              No widget load seen yet. Add the snippet to your site and open a page on an allowed domain.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {loaded.map((row) => (
                <li key={row.host} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="font-mono text-sm text-body">{row.host}</span>
                  <time className="text-xs text-muted" dateTime={row.lastSeenAt}>
                    Last loaded {formatRelativeTime(row.lastSeenAt, now)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="installation-rejected" className="space-y-2">
          <h4 id="installation-rejected" className="text-sm font-medium text-heading">
            Refused hostnames
          </h4>
          {rejected.length === 0 ? (
            <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted">
              No refused hostnames in the last 30 days.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rejected.map((row) => (
                <li key={row.host} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <span className="font-mono text-sm text-body">{row.host}</span>
                    <time className="ml-3 text-xs text-muted" dateTime={row.lastSeenAt}>
                      Refused {formatRelativeTime(row.lastSeenAt, now)}
                    </time>
                  </div>
                  {isAdmin ? (
                    <AllowForm productId={productId} host={row.host} sibling={row.sibling} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {rejected.length > 0 && !isAdmin ? (
            <p className="text-xs text-muted">Only Workspace admins can allow a hostname.</p>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
