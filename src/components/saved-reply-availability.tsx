"use client";

import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * Availability multi-select for saved replies (issue #200), shared by the
 * /saved-replies form and the composer's Save-reply modal. "All products" is
 * a first-class choice: selecting it clears the specific selection; picking
 * any Product leaves All-products. Controlled — the surface owns the value
 * (hidden form input or action argument).
 */
export function SavedReplyAvailabilityField({
  products,
  selected,
  onChange,
  disabled = false,
  label = "Available in",
}: {
  products: { id: string; name: string }[];
  selected: string[];
  onChange: (productIds: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const idPrefix = useId();
  const allProducts = selected.length === 0;

  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-all`}
          checked={allProducts}
          disabled={disabled}
          onCheckedChange={(checked) => {
            if (checked) onChange([]);
          }}
        />
        <label htmlFor={`${idPrefix}-all`} className="text-sm text-heading">
          All products
        </label>
      </div>
      {products.map((product) => (
        <div key={product.id} className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-${product.id}`}
            checked={selected.includes(product.id)}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange(
                checked
                  ? [...selected, product.id]
                  : selected.filter((id) => id !== product.id),
              );
            }}
          />
          <label htmlFor={`${idPrefix}-${product.id}`} className="text-sm text-heading">
            {product.name}
          </label>
        </div>
      ))}
    </div>
  );
}
