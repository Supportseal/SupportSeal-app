"use client";

import { useState } from "react";

import { createProductAction } from "../actions";

const PRESETS = [
  { name: "Blue", value: "#2563eb" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Pink", value: "#db2777" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Amber", value: "#ca8a04" },
  { name: "Cyan", value: "#0891b2" },
  { name: "Slate", value: "#475569" },
] as const;

function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const c = m[1];
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return (
    0.2126 * lin(parseInt(c.slice(0, 2), 16) / 255) +
    0.7152 * lin(parseInt(c.slice(2, 4), 16) / 255) +
    0.0722 * lin(parseInt(c.slice(4, 6), 16) / 255)
  );
}

export function ProductStepForm({ error }: { error?: string }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("#2563eb");

  const contrast = (1.05) / (relativeLuminance(color) + 0.05);
  const lowContrast = contrast < 3;

  return (
    <form action={createProductAction} className="space-y-6">
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-5">
          <div>
            <label htmlFor="name" className="text-sm font-medium text-heading">
              Product name
            </label>
            <input
              id="name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme Analytics"
              required
              maxLength={60}
              className="mt-1.5 h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-heading"
            />
            <p className="mt-1 text-xs text-muted">
              Customers see this name in the chat widget and emails.
            </p>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-heading">Primary colour</legend>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {PRESETS.map((preset) => (
                <label
                  key={preset.value}
                  className="flex cursor-pointer flex-col items-center gap-1.5 rounded-md p-2 hover:bg-hover"
                  title={preset.name}
                >
                  <input
                    type="radio"
                    name="primaryColorPreset"
                    value={preset.value}
                    checked={color === preset.value}
                    onChange={() => setColor(preset.value)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={`size-8 rounded-md ring-2 ring-offset-2 ring-offset-surface ${
                      color === preset.value ? "ring-primary" : "ring-transparent"
                    }`}
                    style={{ backgroundColor: preset.value }}
                  />
                  <span className="text-xs text-body">{preset.name}</span>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="color"
                aria-label="Custom colour"
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"}
                onChange={(event) => setColor(event.target.value)}
                className="h-9 w-14 cursor-pointer rounded-md border border-border-strong bg-surface p-1"
              />
              <input
                type="hidden"
                name="primaryColor"
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb"}
              />
              <span className="text-xs text-muted">
                Custom {/^#[0-9a-f]{6}$/i.test(color) ? color : ""}
              </span>
            </div>
            {lowContrast ? (
              <p className="mt-2 text-xs text-warning">
                This colour may be hard to see on light pages — advisory only.
              </p>
            ) : null}
          </fieldset>
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-sm font-medium text-heading">Live preview</p>
          <div className="overflow-hidden rounded-lg border border-border">
            <iframe
              title="Widget preview"
              src={`/widget-preview?previewOnly=1&name=${encodeURIComponent(name || "Your Product")}&color=${encodeURIComponent(color)}`}
              className="h-80 w-full border-0 bg-body-bg"
            />
          </div>
        </div>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <button
        type="submit"
        className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-contrast hover:bg-primary-dark"
      >
        Continue
      </button>
    </form>
  );
}
