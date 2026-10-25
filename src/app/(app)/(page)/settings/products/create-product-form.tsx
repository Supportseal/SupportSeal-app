"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { expandHexColor } from "@/lib/hex-color";
import { normalizeDomain, wwwSibling } from "@/lib/domain";
import { createProductAction, type ProductFormState } from "./actions";

const initialState: ProductFormState = {};
const DEFAULT_COLOR = "#2563eb";

export function CreateProductForm() {
  const [state, formAction, pending] = useActionState(createProductAction, initialState);
  const router = useRouter();
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [hexDraft, setHexDraft] = useState(DEFAULT_COLOR);
  const [hexTouched, setHexTouched] = useState(false);
  const hexInputRef = useRef<HTMLInputElement>(null);

  const parsedColor = expandHexColor(hexDraft);
  const showHexError = hexTouched && parsedColor === null;

  const [domainsDraft, setDomainsDraft] = useState("");
  const [excludedSiblings, setExcludedSiblings] = useState<string[]>([]);
  const typedDomains = Array.from(
    new Set(
      domainsDraft
        .split(/[\s,]+/u)
        .map((token) => normalizeDomain(token.trim()))
        .filter((domain): domain is string => domain !== null),
    ),
  );
  // Offer each apex/www counterpart that is not already typed (issue #195).
  const companions = Array.from(
    new Set(
      typedDomains.flatMap((domain) => {
        const sibling = wwwSibling(domain);
        return sibling && !typedDomains.includes(sibling) ? [sibling] : [];
      }),
    ),
  );

  useEffect(() => {
    if (!state.created) return;
    toast("Product created", { description: state.created.name });
    router.push(`/settings/products/${state.created.id}`);
  }, [state.created, router]);

  function onColorChange(value: string) {
    setHexDraft(value);
    const parsed = expandHexColor(value);
    if (parsed) setColor(parsed);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (parsedColor === null) {
      event.preventDefault();
      setHexTouched(true);
      hexInputRef.current?.focus();
    }
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-medium text-heading">Add a Product</h2>
          <p className="mt-1 text-sm text-muted">
            Name it, give it a colour, and list the domains it runs on.
          </p>
        </div>
        <form action={formAction} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="name">Product name</Label>
            <Input id="name" name="name" placeholder="Alpha SaaS" required maxLength={60} />
          </div>
          <div>
            <Label htmlFor="primaryColor">Primary colour</Label>
            <div className="flex items-center gap-2">
              <Input
                ref={hexInputRef}
                id="primaryColor"
                name="primaryColor"
                type="text"
                value={hexDraft}
                onChange={(event) => onColorChange(event.target.value)}
                onBlur={() => setHexTouched(true)}
                placeholder={DEFAULT_COLOR}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                state={showHexError ? "invalid" : "default"}
                aria-invalid={showHexError}
                aria-describedby={showHexError ? "primaryColor-error" : undefined}
                className="w-28 font-medium"
              />
              <Input
                type="color"
                aria-label="Colour picker"
                value={color}
                onChange={(event) => onColorChange(event.target.value)}
                className="h-[38px] w-16 p-1"
              />
              <span className="text-sm text-muted">Used in the widget and inbox</span>
            </div>
            {showHexError ? (
              <p id="primaryColor-error" className="mt-1 text-xs text-danger">
                Enter a hex colour like #2563eb or #f00.
              </p>
            ) : null}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="domains">Domains</Label>
            <Input
              id="domains"
              name="domains"
              placeholder="app.example.com, docs.example.com"
              value={domainsDraft}
              onChange={(event) => setDomainsDraft(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              Comma or space separated. The widget only loads on these domains.
            </p>
            {companions.map((sibling) => (
              <label key={sibling} className="mt-2 flex items-center gap-2 text-sm text-body">
                <input
                  type="checkbox"
                  name="includeSibling"
                  value={sibling}
                  checked={!excludedSiblings.includes(sibling)}
                  onChange={(event) =>
                    setExcludedSiblings((prev) =>
                      event.target.checked
                        ? prev.filter((s) => s !== sibling)
                        : [...prev, sibling],
                    )
                  }
                  className="size-4 accent-[var(--vx-primary)]"
                />
                <span>
                  Also allow <span className="font-mono">{sibling}</span>
                </span>
              </label>
            ))}
          </div>
          {state.error ? <p className="text-sm text-danger sm:col-span-2">{state.error}</p> : null}
          {state.created ? (
            <p className="text-sm text-success sm:col-span-2">
              Product created —{" "}
              <Link
                href={`/settings/products/${state.created.id}`}
                className="font-medium underline"
              >
                open its settings
              </Link>
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create Product"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
