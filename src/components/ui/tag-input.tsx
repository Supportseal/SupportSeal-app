"use client";

import { useMemo, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/input";

export function TagInput({
  value,
  onValueChange,
  suggestions = [],
  placeholder,
  readOnly,
  className,
}: {
  value: string[];
  onValueChange: (value: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const filtered = useMemo(
    () =>
      suggestions.filter(
        (item) => item.toLowerCase().includes(draft.toLowerCase()) && !value.includes(item),
      ),
    [draft, suggestions, value],
  );

  function add(tag: string) {
    const next = tag.trim();
    if (!next || value.includes(next) || readOnly) return;
    onValueChange([...value, next]);
    setDraft("");
  }

  return (
    <div className={cn("rounded-md border border-border-strong bg-surface px-2 py-1.5", className)}>
      <div className="flex flex-wrap gap-1.5">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-primary-label px-2 py-0.5 text-[0.8125rem] text-primary"
          >
            {tag}
            {readOnly ? null : (
              <button type="button" onClick={() => onValueChange(value.filter((item) => item !== tag))}>
                <IconX className="size-3.5" />
              </button>
            )}
          </span>
        ))}
        {readOnly ? null : (
          <input
            value={draft}
            placeholder={placeholder}
            className="min-w-24 flex-1 bg-transparent py-1 text-[0.9375rem] text-heading outline-none placeholder:text-muted"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add(draft.replace(",", ""));
              }
              if (event.key === "Backspace" && !draft && value.length) {
                onValueChange(value.slice(0, -1));
              }
            }}
          />
        )}
      </div>
      {draft && filtered.length ? (
        <ul className="mt-1 max-h-40 overflow-auto rounded-md border border-border-strong bg-surface p-1">
          {filtered.slice(0, 8).map((item) => (
            <li key={item}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left text-[0.9375rem] text-heading hover:bg-primary-label hover:text-primary"
                onClick={() => add(item)}
              >
                {item}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Typeahead({
  options,
  placeholder,
}: {
  options: string[];
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const matches = options.filter((item) => item.toLowerCase().includes(value.toLowerCase())).slice(0, 6);

  return (
    <div className="relative">
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
      />
      {value && matches.length ? (
        <ul className="absolute z-20 mt-1 w-full rounded-lg border border-border-strong bg-surface p-1 shadow-menu">
          {matches.map((item) => (
            <li key={item}>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-[0.9375rem] text-heading hover:bg-hover"
                onClick={() => setValue(item)}
              >
                {item}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
