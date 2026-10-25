"use client";

import { useActionState } from "react";
import { format } from "date-fns";

import { CopyButton } from "@/components/copy-button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RecordCheck } from "@/lib/email/mail-domain";
import {
  removeMailDomainAction,
  saveMailDomainAction,
  verifyMailDomainAction,
  type MailSetupState,
} from "./actions";

export type MailSetupPanelProps = {
  productId: string;
  isAdmin: boolean;
  domain: {
    name: string;
    verifiedAt: string | null;
    lastCheckedAt: string | null;
    records: Array<{ id: string; type: string; host: string; value: string; priority?: number }>;
  } | null;
};

const initial: MailSetupState = {};
const STATUS_LABEL: Record<RecordCheck["status"], string> = {
  ok: "Found",
  missing: "Missing",
  mismatch: "Doesn't match",
  unknown: "Couldn't check",
};

function ProductField({ productId }: { productId: string }) {
  return <input type="hidden" name="productId" value={productId} />;
}

/**
 * Shared by the onboarding Mail step and Product settings → Email: the exact
 * DNS records for a custom inbound mail domain, a Verify action that runs
 * real DNS lookups, and a status that only reads "Verified" once they pass.
 */
export function MailSetupPanel({ productId, isAdmin, domain }: MailSetupPanelProps) {
  const [saveState, save, saving] = useActionState(saveMailDomainAction, initial);

  if (!isAdmin) {
    return (
      <p className="text-sm text-muted">
        {domain
          ? `${domain.name}: ${domain.verifiedAt ? "verified" : "not verified yet"}.`
          : "No custom mail domain is set up."}{" "}
        Only Workspace admins can change mail setup.
      </p>
    );
  }

  if (!domain) {
    return (
      <form action={save} className="space-y-3">
        <ProductField productId={productId} />
        <label htmlFor="mail-domain" className="text-sm font-medium text-heading">
          Your mail domain
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="mail-domain"
            name="domain"
            placeholder="support.acme.com"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1"
            aria-describedby="mail-domain-hint"
          />
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Show DNS records"}
          </Button>
        </div>
        <p id="mail-domain-hint" className="text-xs text-muted">
          Use a domain or subdomain dedicated to support mail (e.g. support.acme.com): its MX will
          point at this installation, so don&apos;t use one that receives other mail.
        </p>
        {saveState.error ? <p className="text-sm text-danger">{saveState.error}</p> : null}
      </form>
    );
  }

  // Keyed by domain: a verify result belongs to the domain it checked, so a
  // switch ("Use a different domain") must not leak the previous domain's
  // checks or success/failure into the new one (or over the server's
  // verifiedAt). The key remounts the card and resets its action state.
  return <VerifiedDomainCard key={domain.name} productId={productId} domain={domain} />;
}

function VerifiedDomainCard({ productId, domain }: { productId: string; domain: NonNullable<MailSetupPanelProps["domain"]> }) {
  const [verifyState, verify, verifying] = useActionState(verifyMailDomainAction, initial);
  const [removeState, remove, removing] = useActionState(removeMailDomainAction, initial);

  const verified = verifyState.verified ?? Boolean(domain.verifiedAt);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-sm text-heading">
          {domain.name}
        </code>
        <Badge variant="light" color={verified ? "success" : "warning"}>
          {verified ? "Verified" : "Not verified"}
        </Badge>
        {domain.lastCheckedAt ? (
          <span className="text-xs text-muted">
            Last checked {format(new Date(domain.lastCheckedAt), "d MMM yyyy, HH:mm")}
          </span>
        ) : null}
      </div>

      {domain.records.some((record) => record.type === "MX") ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">DNS records to add</caption>
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {domain.records.map((record) => (
                <tr key={`${record.id}-${record.value}`} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-medium text-heading">
                    {record.type}
                    {record.priority ? <span className="block text-xs text-muted">priority {record.priority}</span> : null}
                  </td>
                  {[record.host, record.value].map((cell, index) => (
                    <td key={index} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="break-all font-mono text-xs text-heading select-all">{cell}</code>
                        <CopyButton value={cell} size="xs" variant="text" />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Alert color="warning">
          This installation hasn&apos;t published a mail host, so there are no records to add yet.
          Operators: set <code>INBOUND_MX_HOSTS</code> (see the self-hosting guide).
        </Alert>
      )}
      <p className="text-xs text-muted">
        If your DNS console appends your zone name automatically, enter each host without it.
        DNS changes may appear within minutes; cached records can take longer, depending on
        your provider and their time to live (TTL). Try Verify records again later. This wait
        only affects your custom mail domain, not the chat widget or your generated support address.
      </p>

      <div aria-live="polite" className="space-y-2">
        {verifyState.checks ? (
          <ul className="space-y-1.5">
            {verifyState.checks.map((check) => (
              <li key={check.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="light" color={check.status === "ok" ? "success" : check.status === "unknown" ? "secondary" : "danger"}>
                  {STATUS_LABEL[check.status]}
                </Badge>
                <span className="font-medium text-heading">{check.label}</span>
                <span className="text-muted">{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {verifyState.verified ? (
          <Alert color="success">
            Verified. Mail sent to any address at {domain.name} now arrives in this Product&apos;s inbox.
          </Alert>
        ) : null}
        {verifyState.error || removeState.error ? (
          <p className="text-sm text-danger">{verifyState.error ?? removeState.error}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action={verify}>
          <ProductField productId={productId} />
          <Button type="submit" disabled={verifying || domain.records.every((r) => r.type !== "MX")}>
            {verifying ? "Checking DNS…" : verified ? "Check again" : "Verify records"}
          </Button>
        </form>
        <form action={remove}>
          <ProductField productId={productId} />
          <Button type="submit" variant="text" color="secondary" disabled={removing}>
            Use a different domain
          </Button>
        </form>
      </div>
    </div>
  );
}
