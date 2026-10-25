"use client";

import { useActionState, useState } from "react";
import { IconTrash } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeDomain, wwwSibling } from "@/lib/domain";
import { addDomainAction, removeDomainAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

export function DomainsCard({
  productId,
  domains,
}: {
  productId: string;
  domains: { id: string; domain: string }[];
}) {
  const [state, formAction, pending] = useActionState(addDomainAction, initialState);
  const [draft, setDraft] = useState("");
  const [includeSibling, setIncludeSibling] = useState(true);

  const normalized = normalizeDomain(draft);
  const candidate = normalized ? wwwSibling(normalized) : null;
  // Offer the counterpart only while it is not already allowed.
  const sibling = candidate && !domains.some((d) => d.domain === candidate) ? candidate : null;

  return (
    <Card id="domains" className="scroll-mt-6">
      <CardContent className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-medium text-heading">Domains</h2>
          <p className="mt-1 text-sm text-muted">
            The widget only loads on these domains (localhost always works in development).
          </p>
          <p className="mt-1 text-sm text-muted">
            Domains match the exact hostname: <span className="font-mono">example.com</span> and{" "}
            <span className="font-mono">www.example.com</span> are separate entries, and{" "}
            <span className="font-mono">*.example.com</span> covers subdomains but not{" "}
            <span className="font-mono">example.com</span> itself.
          </p>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {domains.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted">No domains yet.</li>
          ) : (
            domains.map((domain) => (
              <li key={domain.id} className="flex items-center justify-between px-4 py-2.5">
                <span className="font-mono text-sm text-body">{domain.domain}</span>
                <form action={removeDomainAction}>
                  <input type="hidden" name="productId" value={productId} />
                  <input type="hidden" name="domainId" value={domain.id} />
                  <Button type="submit" variant="text" color="danger" size="xs">
                    <IconTrash className="size-3.5" />
                    Remove
                  </Button>
                </form>
              </li>
            ))
          )}
        </ul>
        <form
          action={formAction}
          onReset={() => {
            setDraft("");
            setIncludeSibling(true);
          }}
          className="space-y-3"
        >
          <input type="hidden" name="productId" value={productId} />
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="domain">Add domain</Label>
              <Input
                id="domain"
                name="domain"
                placeholder="app.example.com"
                required
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </div>
          {sibling ? (
            <label className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                name="includeSibling"
                checked={includeSibling}
                onChange={(event) => setIncludeSibling(event.target.checked)}
                className="size-4 accent-[var(--vx-primary)]"
              />
              <span>
                Also allow <span className="font-mono">{sibling}</span>
              </span>
            </label>
          ) : null}
        </form>
        {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      </CardContent>
    </Card>
  );
}
