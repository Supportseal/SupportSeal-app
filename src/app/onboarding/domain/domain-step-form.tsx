"use client";

import { useState } from "react";

import { domainAllowlistStatus } from "@/lib/domain-allowlist";
import { saveDomainsAction, skipDomainsAction } from "../actions";

export function DomainStepForm({
  existingDomains,
  error,
  productId,
}: {
  existingDomains: string[];
  error?: string;
  productId: string;
}) {
  void productId;
  const [domains, setDomains] = useState<string[]>(existingDomains.filter((d) => d !== "localhost"));
  const [draft, setDraft] = useState("");
  const [allowLocalhost, setAllowLocalhost] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  function normalize(input: string): string | null {
    let value = input.trim().toLowerCase();
    if (value.includes("://")) {
      try {
        value = new URL(input.trim()).hostname;
      } catch {
        return null;
      }
    }
    value = value.replace(/^[./]+/u, "").split("/")[0].split(":")[0].replace(/\.+$/u, "");
    if (value === "localhost" || /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value) || /^\*\..+\..+$/u.test(value)) {
      return value;
    }
    return null;
  }

  function addDraft() {
    const value = normalize(draft);
    if (!value) {
      setLocalError("Enter a hostname like app.example.com");
      return;
    }
    if (!domains.includes(value)) setDomains([...domains, value]);
    setDraft("");
    setLocalError(null);
  }

  function hiddenValue(): string {
    // Include a still-typed draft if it normalises, so nothing typed is lost.
    const draftValue = normalize(draft);
    const all = draftValue && !domains.includes(draftValue) ? [...domains, draftValue] : domains;
    return all.join(", ");
  }

  return (
    <div className="space-y-5">
      <form action={saveDomainsAction} className="space-y-4">
        <input type="hidden" name="domains" value={hiddenValue()} />
        <input type="hidden" name="allowLocalhost" value={allowLocalhost ? "on" : ""} />
        <div>
          <label htmlFor="domain" className="text-sm font-medium text-heading">
            Allowed domains
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="domain"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDraft();
                }
              }}
              placeholder="app.example.com"
              className="h-10 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-heading"
            />
            <button
              type="button"
              onClick={addDraft}
              className="h-10 rounded-md border border-border-strong px-4 text-sm font-medium text-heading hover:bg-hover"
            >
              Add
            </button>
          </div>
          {localError ? <p className="mt-1 text-xs text-danger">{localError}</p> : null}
          <p className="mt-1 text-xs text-muted">
            Add the hostname visitors actually use. example.com and www.example.com are separate
            exact entries. *.example.com covers subdomains such as www.example.com and
            app.example.com, but not the root domain (apex): add example.com separately.
          </p>
          <p className="mt-1 text-xs text-muted">
            You can paste a full URL; we keep only its hostname. Saving this list needs no DNS
            changes. Reload your site after saving to test the widget.
          </p>
        </div>

        {domains.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {domains.map((domain) => (
              <li
                key={domain}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm text-heading"
              >
                {domain}
                <button
                  type="button"
                  aria-label={`Remove ${domain}`}
                  className="text-muted hover:text-danger"
                  onClick={() => setDomains(domains.filter((d) => d !== domain))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <label className="flex items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={allowLocalhost}
            onChange={(event) => setAllowLocalhost(event.target.checked)}
            className="size-4 accent-[var(--vx-primary)]"
          />
          Allow localhost for development
        </label>

        {domainAllowlistStatus(domains) !== "ok" ? (
          <p className="text-sm text-warning" role="status">
            The widget only loads on listed domains. Add your site&apos;s hostname before you go
            live, or it will not appear for your customers.
          </p>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-contrast hover:bg-primary-dark"
          >
            Continue
          </button>
        </div>
      </form>
      <form action={skipDomainsAction}>
        <button type="submit" className="text-sm text-muted hover:text-heading">
          Skip for now, I&apos;ll test on localhost
        </button>
      </form>
    </div>
  );
}
