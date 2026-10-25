"use client";

import { useActionState, useState } from "react";

import { SavedReplyAvailabilityField } from "@/components/saved-reply-availability";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SAVED_REPLY_BODY_MAX, SAVED_REPLY_NAME_MAX } from "@/lib/saved-reply-limits";
import { createSavedReplyAction, type SavedReplyFormState } from "./actions";

const initialState: SavedReplyFormState = {};

export function SavedReplyForm({ products }: { products: { id: string; name: string }[] }) {
  // [] = All products; ids = offered in those Products' conversations.
  const [productIds, setProductIds] = useState<string[]>([]);
  const [state, formAction, pending] = useActionState(
    async (prev: SavedReplyFormState, formData: FormData) => {
      const next = await createSavedReplyAction(prev, formData);
      // React resets the uncontrolled name/body after the action; the
      // controlled availability must follow, or it leaks into the next reply.
      if (!next.error) setProductIds([]);
      return next;
    },
    initialState,
  );

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <h2 className="text-lg font-medium text-heading">Add a saved reply</h2>
        <form action={formAction} className="space-y-3">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="Refund policy" required maxLength={SAVED_REPLY_NAME_MAX} />
          </div>
          <div className="space-y-1.5">
            <Label>Available in</Label>
            <SavedReplyAvailabilityField
              products={products}
              selected={productIds}
              onChange={setProductIds}
            />
            <input type="hidden" name="productIds" value={productIds.join(",")} />
          </div>
          <div>
            <Label htmlFor="body">Body</Label>
            <textarea
              id="body"
              name="body"
              rows={4}
              required
              maxLength={SAVED_REPLY_BODY_MAX}
              className="w-full resize-none rounded-md border border-border-strong bg-surface p-2.5 text-sm text-heading placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary"
            />
          </div>
          {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save reply"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
