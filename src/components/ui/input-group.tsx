import { cn } from "@/lib/cn";

export function InputGroup({
  className,
  merged = true,
  ...props
}: React.ComponentProps<"div"> & { merged?: boolean }) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-stretch [&>input]:min-w-0 [&>input]:flex-1",
        merged &&
          "[&>*:not(:first-child)]:-ms-px [&>*:first-child]:rounded-e-none [&>*:last-child]:rounded-s-none [&>*:not(:first-child):not(:last-child)]:rounded-none",
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupText({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border border-border bg-surface-2 px-3 text-[0.9375rem] text-muted",
        className,
      )}
      {...props}
    />
  );
}
