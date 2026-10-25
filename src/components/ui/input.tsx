import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const inputState = {
  default:
    "border-border-strong hover:border-muted focus:border-primary focus:shadow-[0_0_0_0.15rem_var(--vx-focus-ring)] focus:outline-none",
  valid:
    "border-success focus:border-success focus:shadow-[0_0_0_0.15rem_color-mix(in_srgb,var(--vx-success)_24%,transparent)] focus:outline-none",
  invalid:
    "border-danger focus:border-danger focus:shadow-[0_0_0_0.15rem_color-mix(in_srgb,var(--vx-danger)_24%,transparent)] focus:outline-none",
} as const;

const inputVariants = cva(
  "w-full border bg-surface text-heading placeholder:text-muted transition-colors file:me-3 file:border-0 file:bg-transparent file:text-[0.9375rem] file:font-medium file:text-heading",
  {
    variants: {
      size: {
        sm: "h-8 px-2.5 text-[0.8125rem] rounded-md",
        md: "h-[38px] px-3.5 text-[0.9375rem] rounded-md",
        lg: "h-12 px-4 text-base rounded-lg",
      },
      shape: {
        default: "",
        rounded: "rounded-full",
      },
      state: inputState,
      plaintext: {
        true: "border-transparent bg-transparent px-0 shadow-none hover:border-transparent focus:border-transparent focus:shadow-none",
        false: "",
      },
    },
    defaultVariants: {
      size: "md",
      shape: "default",
      state: "default",
      plaintext: false,
    },
  },
);

export type InputProps = Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>;

export function Input({ className, size, shape, state, plaintext, ...props }: InputProps) {
  return (
    <input
      className={cn(
        inputVariants({ size, shape, state, plaintext }),
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  state = "default",
  ...props
}: React.ComponentProps<"textarea"> & { state?: "default" | "valid" | "invalid" }) {
  return (
    <textarea
      className={cn(
        "min-h-24 w-full rounded-md border bg-surface px-3.5 py-2.5 text-[0.9375rem] text-heading placeholder:text-muted transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        inputState[state],
        className,
      )}
      {...props}
    />
  );
}

export function FloatingInput({
  id,
  label,
  className,
  ...props
}: InputProps & { label: string }) {
  return (
    <div className="relative">
      <Input
        id={id}
        placeholder=" "
        className={cn("peer placeholder-transparent", className)}
        {...props}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute start-3.5 top-1/2 origin-[0] -translate-y-1/2 bg-surface px-1 text-[0.9375rem] text-muted transition-all peer-focus:top-0 peer-focus:text-[0.75rem] peer-focus:text-primary peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:text-[0.75rem]"
      >
        {label}
      </label>
    </div>
  );
}

export { inputVariants };
