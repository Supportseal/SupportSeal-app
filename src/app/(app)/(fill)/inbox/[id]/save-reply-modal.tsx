"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { SavedReplyAvailabilityField } from "@/components/saved-reply-availability";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { track } from "@/lib/analytics";
import { SAVED_REPLY_BODY_MAX, SAVED_REPLY_NAME_MAX } from "@/lib/saved-reply-limits";

import { saveReplyFromComposerAction } from "../actions";

/**
 * Save-reply-from-composer modal (issue #200): the current draft arrives
 * pre-filled and editable, next to a name and the availability multi-select —
 * the same form as /saved-replies. Saving creates the reply without clearing
 * or sending the draft. The parent remounts this component for every open
 * (key), so each session starts from the composer's current draft.
 */
export function SaveReplyModal({
  open,
  onOpenChange,
  draft,
  products,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: string;
  products: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState(draft);
  // [] = All products, matching the /saved-replies form's default scope.
  const [productIds, setProductIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A composer draft has no length cap and arrives intact; surface the overrun
  // instead of letting the server reject (or a slice drop) the tail.
  const overBy = body.trim().length - SAVED_REPLY_BODY_MAX;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveReplyFromComposerAction({ name, body, productIds });
      if (result.error) {
        setError(result.error);
        return;
      }
      track("saved_reply_created", { from: "composer" });
      toast.success("Saved reply created");
      onSaved();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save reply</DialogTitle>
          <DialogDescription>
            Name it and choose where it is offered. The composer keeps its draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="save-reply-name">Name</Label>
            <Input
              id="save-reply-name"
              value={name}
              maxLength={SAVED_REPLY_NAME_MAX}
              placeholder="Refund policy"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Available in</Label>
            <SavedReplyAvailabilityField
              products={products}
              selected={productIds}
              onChange={setProductIds}
            />
          </div>
          <div>
            <Label htmlFor="save-reply-body">Body</Label>
            <textarea
              id="save-reply-body"
              rows={5}
                            value={body}
              onChange={(event) => setBody(event.target.value)}
              className="w-full resize-none rounded-md border border-border-strong bg-surface p-2.5 text-sm text-heading placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary"
            />
          </div>
          {overBy > 0 ? (
            <p role="alert" className="text-sm text-danger">
              This draft is {overBy} characters over the {SAVED_REPLY_BODY_MAX}-character limit. Shorten it to save.
            </p>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="text"
            color="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => save()} disabled={pending || !name.trim() || !body.trim() || overBy > 0}>
            {pending ? "Saving…" : "Save reply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
