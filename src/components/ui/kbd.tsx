import { cn } from "@/lib/cn";

export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-surface-2 px-1.5 font-sans text-[0.6875rem] font-medium text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
