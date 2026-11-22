"use client";

import { startTransition, useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AgentAlertPreferences } from "@/lib/agent-alerts";

import { setNotificationPreferencesAction, type NotificationFormState } from "./actions";

const initialState: NotificationFormState = {};

/**
 * The member's own new-message email alerts (docs/design/agent-alerts.md).
 * Every member, Admin or Agent, sees and changes only their own choices.
 */
export function NotificationsForm({
  email,
  preferences,
  mailConfigured,
}: {
  email: string;
  preferences: AgentAlertPreferences;
  mailConfigured: boolean;
}) {
  const [state, formAction, pending] = useActionState(setNotificationPreferencesAction, initialState);
  const [newConversation, setNewConversation] = useState(preferences.newConversation);
  const [customerReply, setCustomerReply] = useState(preferences.customerReply);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-lg font-medium text-heading">Email alerts</h2>
          <p className="mt-1 text-sm text-muted">
            When you are not in the dashboard, we email <strong className="text-body">{email}</strong>{" "}
            about customer messages that are still unread and unanswered after 2 minutes.
            Messages that arrive close together come in one email. While a dashboard tab is
            open you get the in-browser notification instead.
          </p>
        </div>

        {!mailConfigured ? (
          <p
            role="note"
            className="rounded-md border border-warning bg-warning-label px-3 py-2 text-sm text-body"
          >
            Outbound email is not configured on this server, so alerts cannot be sent. Set{" "}
            <code>SENDGRID_API_KEY</code> or <code>SMTP_URL</code> to turn them on.
          </p>
        ) : null}

        {/*
          Submitted by hand, not via <form action>: React resets a form after
          an action, and Radix switches answer that reset by snapping back to
          their first value, so the page would show the old choice.
        */}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(() => formAction(data));
          }}
        >
          <div className="flex items-start gap-3">
            <Switch
              id="newConversation"
              name="newConversation"
              checked={newConversation}
              onCheckedChange={setNewConversation}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor="newConversation">New conversations</Label>
              <p className="text-sm text-muted">A customer starts a chat, sends an email or uses the contact form.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch
              id="customerReply"
              name="customerReply"
              checked={customerReply}
              onCheckedChange={setCustomerReply}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor="customerReply">Customer replies</Label>
              <p className="text-sm text-muted">A customer writes again in an existing conversation.</p>
            </div>
          </div>
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            {state.saved && !pending ? (
              <p role="status" className="text-sm text-success">
                Saved.
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
