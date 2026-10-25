import { cn } from "@/lib/cn";

export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-w-0", className)} {...props} />;
}

export function FieldHint({
  className,
  state,
  ...props
}: React.ComponentProps<"p"> & { state?: "muted" | "valid" | "invalid" }) {
  return (
    <p
      className={cn(
        "mt-1 text-[0.8125rem]",
        state === "valid" ? "text-success" : state === "invalid" ? "text-danger" : "text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function FormSeparator({ className, ...props }: React.ComponentProps<"hr">) {
  return <hr className={cn("my-6 border-border", className)} {...props} />;
}
