"use client";

import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_WIDGET_GREETING,
  GREETING_MAX_CHARS,
  GREETING_MAX_LINES,
  greetingLength,
  normalizeGreeting,
  parseGreeting,
} from "@/lib/widget-greeting";
import { setGreetingAction, type GreetingFormState } from "../actions";

const initialState: GreetingFormState = {};

/**
 * Widget greeting (docs/design/branding.md "Product settings"): a plain-text
 * greeting for fresh chats, with a live counter and explicit Save/Discard.
 * The draft is lifted to the Widget tab so the preview shows it unsaved.
 * Client checks are for quick feedback; the server re-validates.
 */
export function GreetingCard({
  productId,
  saved,
  draft,
  onDraftChange,
  onSaved,
  isAdmin,
}: {
  productId: string;
  saved: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onSaved: (greeting: string | null) => void;
  isAdmin: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    async (prev: GreetingFormState, formData: FormData) => {
      const result = await setGreetingAction(prev, formData);
      if (result.saved) onSaved(result.saved.greeting);
      return result;
    },
    initialState,
  );
  // The confirmation belongs to one save result; typing again dismisses it.
  const [dismissed, setDismissed] = useState<GreetingFormState | null>(null);
  const savedNotice = Boolean(state.saved) && dismissed !== state;

  const dirty = normalizeGreeting(draft) !== (saved ?? "");
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const normalized = normalizeGreeting(draft);
  const chars = greetingLength(normalized);
  const lines = normalized === "" ? 0 : normalized.split("\n").length;
  const check = parseGreeting(draft);
  const clientError = check.ok ? null : check.error;
  const error = clientError ?? (dirty ? null : (state.error ?? null));

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h3 className="text-lg font-medium text-heading">Greeting</h3>
          <p className="mt-1 text-sm text-muted">
            Shown to visitors when they open a new chat, before anyone has written. When you
            are away it appears above the message form. Leave it empty to use the built-in
            greeting.
          </p>
        </div>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="productId" value={productId} />
          <div className="max-w-xl">
            <Label htmlFor="greeting">Greeting text</Label>
            <Textarea
              id="greeting"
              name="greeting"
              rows={3}
              dir="auto"
              value={draft}
              onChange={(event) => {
                setDismissed(state);
                onDraftChange(event.target.value);
              }}
              placeholder={DEFAULT_WIDGET_GREETING}
              disabled={!isAdmin}
              state={clientError ? "invalid" : "default"}
              aria-invalid={clientError ? true : undefined}
              aria-describedby="greetingHelp greetingCount"
            />
            <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted">
              <span id="greetingHelp">
                Plain text, up to {GREETING_MAX_LINES} lines. Links and formatting are shown as
                typed.
              </span>
              <span
                id="greetingCount"
                className={chars > GREETING_MAX_CHARS || lines > GREETING_MAX_LINES ? "text-danger" : undefined}
              >
                {chars}/{GREETING_MAX_CHARS} characters · {lines}/{GREETING_MAX_LINES} lines
              </span>
            </div>
          </div>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {savedNotice && !dirty ? (
            <p className="text-sm text-success" role="status">
              Greeting saved. Visitors see it the next time the chat loads.
            </p>
          ) : null}
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending || !dirty || clientError !== null}>
                {pending ? "Saving…" : "Save greeting"}
              </Button>
              <Button
                type="button"
                variant="outline"
                color="secondary"
                disabled={pending || !dirty}
                onClick={() => onDraftChange(saved ?? "")}
              >
                Discard
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted">Only Workspace admins can change the greeting.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
