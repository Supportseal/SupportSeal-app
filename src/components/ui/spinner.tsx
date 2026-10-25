import { cn } from "@/lib/cn";

export function Spinner({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-primary/25 border-t-primary",
        className,
      )}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
