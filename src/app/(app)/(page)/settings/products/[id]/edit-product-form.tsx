"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProductAction, type ProductFormState } from "../actions";

const initialState: ProductFormState = {};

export function EditProductForm({
  product,
}: {
  product: { id: string; name: string; primaryColor: string };
}) {
  const [state, formAction, pending] = useActionState(updateProductAction, initialState);

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <h2 className="text-lg font-medium text-heading">Basics</h2>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="productId" value={product.id} />
          <div>
            <Label htmlFor="name">Product name</Label>
            <Input id="name" name="name" defaultValue={product.name} required maxLength={60} />
          </div>
          <div>
            <Label htmlFor="primaryColor">Primary colour</Label>
            <Input
              id="primaryColor"
              name="primaryColor"
              type="color"
              defaultValue={product.primaryColor}
              className="h-[38px] w-16 p-1"
            />
          </div>
          {state.error ? <p className="text-sm text-danger sm:col-span-2">{state.error}</p> : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
