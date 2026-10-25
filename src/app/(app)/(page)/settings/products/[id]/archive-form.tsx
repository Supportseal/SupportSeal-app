"use client";

import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { archiveAction } from "../actions";

export function ArchiveForm({ productId, archived }: { productId: string; archived: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-lg font-medium text-heading">
            {archived ? "Unarchive Product" : "Archive Product"}
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Archiving stops new customer interactions and hides the widget, but keeps every
            historical Conversation for as long as you keep the data.
          </p>
        </div>
        <form
          action={(formData) => startTransition(() => archiveAction(formData))}
        >
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="archived" value={String(!archived)} />
          <Button type="submit" variant="outline" color={archived ? "success" : "danger"} disabled={pending}>
            {pending ? "Working…" : archived ? "Unarchive" : "Archive"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
