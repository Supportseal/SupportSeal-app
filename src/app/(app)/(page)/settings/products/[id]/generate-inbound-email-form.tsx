"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { generateInboundEmailAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

/** Allocates the inbound address for Products created before issue #45. */
export function GenerateInboundEmailForm({ productId }: { productId: string }) {
  const [state, formAction, pending] = useActionState(generateInboundEmailAction, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="productId" value={productId} />
      <p className="text-sm text-muted">
        This Product was created before inbound addresses were generated
        automatically. Generate one to receive support email.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Generating…" : "Generate inbound address"}
      </Button>
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
    </form>
  );
}
