"use client";

import { useActionState, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setEscalationAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

export type EscalationSettings = {
  productId: string;
  enabled: boolean;
  afterMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  mailConfigured: boolean;
  isAdmin: boolean;
};

/**
 * Unanswered-request alerts (docs/design/escalation.md): per-Product switch
 * and wait time. Shows a visible note when this server has no outbound mail
 * provider, because the alerts cannot be delivered without one.
 */
export function EscalationCard({ settings }: { settings: EscalationSettings }) {
  const [state, formAction, pending] = useActionState(setEscalationAction, initialState);
  const [enabled, setEnabled] = useState(settings.enabled);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h3 className="text-lg font-medium text-heading">Unanswered-request alerts</h3>
          <p className="mt-1 text-sm text-muted">
            When a new chat or email request gets no reply within the wait time,
            every Workspace admin receives one email with the customer&apos;s
            message and a link to the Conversation. Each request alerts at most
            once.
          </p>
        </div>

        {!settings.mailConfigured ? (
          <p
            role="note"
            className="rounded-md border border-warning bg-warning-label px-3 py-2 text-sm text-body"
          >
            Outbound email is not configured on this server, so alerts cannot be
            sent. Set <code>SENDGRID_API_KEY</code> or <code>SMTP_URL</code> to
            turn them on.
          </p>
        ) : null}

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="productId" value={settings.productId} />
          <div className="flex items-center gap-3">
            <Switch
              id="escalationEnabled"
              name="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!settings.isAdmin}
            />
            <Label htmlFor="escalationEnabled">Email admins about unanswered requests</Label>
          </div>
          <div className="max-w-56">
            <Label htmlFor="afterMinutes">Wait time (minutes)</Label>
            <Input
              id="afterMinutes"
              name="afterMinutes"
              type="number"
              inputMode="numeric"
              min={settings.minMinutes}
              max={settings.maxMinutes}
              step={1}
              defaultValue={settings.afterMinutes}
              disabled={!settings.isAdmin}
              required
            />
            <p className="mt-1 text-xs text-muted">
              {settings.minMinutes}–{settings.maxMinutes} minutes. Applies to chat and email.
            </p>
          </div>
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          {settings.isAdmin ? (
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save alerts"}
            </Button>
          ) : (
            <p className="text-sm text-muted">Only Workspace admins can change these settings.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
