"use client";

import { cn } from "@/lib/cn";

export function CustomOption({
  checked,
  className,
  children,
  ...props
}: React.ComponentProps<"label"> & { checked?: boolean }) {
  return (
    <label
      className={cn(
        "flex h-full cursor-pointer gap-3 rounded-lg border p-4 transition-colors",
        checked ? "border-primary bg-primary-label" : "border-border hover:border-muted",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
}

export function CustomOptionBody({
  title,
  description,
  meta,
}: {
  title: string;
  description?: string;
  meta?: React.ReactNode;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-start justify-between gap-2">
        <span className="font-medium text-heading">{title}</span>
        {meta ? <span className="text-[0.9375rem] text-heading">{meta}</span> : null}
      </span>
      {description ? <span className="mt-1 block text-[0.8125rem] text-muted">{description}</span> : null}
    </span>
  );
}
