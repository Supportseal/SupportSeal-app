"use client";

import { useActionState } from "react";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createApiTokenAction, type CreateTokenState } from "./actions";

const initialState: CreateTokenState = {};

export function CreateTokenForm() {
  const [state, formAction, pending] = useActionState(createApiTokenAction, initialState);

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label htmlFor="token-name">Name</Label>
          <Input id="token-name" name="name" placeholder="Provisioning script" maxLength={80} required />
        </div>
        <div className="sm:w-48">
          <Label htmlFor="token-expires">Expires (optional)</Label>
          <Input id="token-expires" name="expiresAt" type="date" />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create token"}
        </Button>
      </form>
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      {state.created ? (
        <div
          className="space-y-2 rounded-md border border-border bg-surface-2 p-3"
          role="status"
          data-testid="new-api-token"
        >
          <p className="text-sm font-medium text-heading">
            Token &ldquo;{state.created.name}&rdquo; created. Copy it now: it is shown only once.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all text-sm select-all">{state.created.token}</code>
            <CopyButton value={state.created.token} label="Copy token" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
