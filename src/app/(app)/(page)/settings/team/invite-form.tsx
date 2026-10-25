"use client";

import { useActionState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createInviteAction, type InviteActionResult } from "./actions";

const initialState: InviteActionResult = {};

export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInviteAction, initialState);
  const [copied, setCopied] = useState(false);

  async function copyInviteUrl() {
    if (!state.inviteUrl) return;
    await navigator.clipboard.writeText(state.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="teammate@example.com" required />
        </div>
        <div className="sm:w-36">
          <Label htmlFor="role">Role</Label>
          <Select name="role" defaultValue="AGENT">
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AGENT">Agent</SelectItem>
              <SelectItem value="ADMIN">Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create invite"}
        </Button>
      </form>
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      {state.inviteUrl ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all text-sm sm:truncate sm:break-normal">{state.inviteUrl}</code>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={copyInviteUrl}>
            {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
      {state.inviteUrl ? (
        <p className="text-xs text-muted">
          Email delivery arrives with the email slice — share this link directly for now.
        </p>
      ) : null}
    </div>
  );
}
