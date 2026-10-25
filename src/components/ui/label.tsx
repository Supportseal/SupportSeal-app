import { cn } from "@/lib/cn";

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("mb-1.5 block text-[0.8125rem] font-medium text-heading", className)}
      {...props}
    />
  );
}
