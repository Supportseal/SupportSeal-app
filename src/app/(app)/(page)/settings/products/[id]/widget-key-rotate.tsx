"use client";

import { useState, useTransition } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { rotateWidgetKeyAction } from "../actions";

/**
 * Admin-only "Rotate widget key" (issue #19). Rotation is immediate and also
 * revokes the old key: every embedded snippet stops loading until it is
 * updated, so the dialog says so before anything happens.
 */
export function WidgetKeyRotate({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function rotate() {
    setOpen(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("productId", productId);
      const result = await rotateWidgetKeyAction({}, formData);
      if (result.error) toast.error(result.error);
      else toast("Widget key rotated");
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setOpen(true)}>
        <IconRefresh className="size-4" />
        Rotate widget key
      </Button>
      <span className="text-xs text-muted">
        Use this if the key is being abused. The previous key stops working immediately — update the
        snippet on your site right after.
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate widget key?</DialogTitle>
            <DialogDescription>
              The widget stops loading on every site still using the current key, and
              there is no grace period. Visitors&apos; open conversations carry over to the new key.
              Rotate only when you can paste the new snippet right away.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" color="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={rotate}>
              Rotate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
