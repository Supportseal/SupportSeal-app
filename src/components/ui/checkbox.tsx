"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { IconCheck, IconMinus } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const checkboxVariants = cva(
  "flex size-[1.125rem] shrink-0 items-center justify-center rounded-[4px] border bg-surface transition-colors focus-visible:shadow-[0_0_0_0.15rem_var(--vx-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      color: {
        primary:
          "border-border-strong data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=checked]:text-primary-contrast data-[state=indeterminate]:text-white",
        secondary:
          "border-border-strong data-[state=checked]:border-secondary data-[state=checked]:bg-secondary data-[state=indeterminate]:border-secondary data-[state=indeterminate]:bg-secondary data-[state=checked]:text-secondary-contrast data-[state=indeterminate]:text-white",
        success:
          "border-border-strong data-[state=checked]:border-success data-[state=checked]:bg-success data-[state=indeterminate]:border-success data-[state=indeterminate]:bg-success data-[state=checked]:text-success-contrast data-[state=indeterminate]:text-white",
        danger:
          "border-border-strong data-[state=checked]:border-danger data-[state=checked]:bg-danger data-[state=indeterminate]:border-danger data-[state=indeterminate]:bg-danger data-[state=checked]:text-danger-contrast data-[state=indeterminate]:text-white",
        warning:
          "border-border-strong data-[state=checked]:border-warning data-[state=checked]:bg-warning data-[state=indeterminate]:border-warning data-[state=indeterminate]:bg-warning data-[state=checked]:text-warning-contrast data-[state=indeterminate]:text-white",
        info:
          "border-border-strong data-[state=checked]:border-info data-[state=checked]:bg-info data-[state=indeterminate]:border-info data-[state=indeterminate]:bg-info data-[state=checked]:text-info-contrast data-[state=indeterminate]:text-white",
        dark:
          "border-border-strong data-[state=checked]:border-dark data-[state=checked]:bg-dark data-[state=indeterminate]:border-dark data-[state=indeterminate]:bg-dark data-[state=checked]:text-dark-contrast data-[state=indeterminate]:text-white",
      },
    },
    defaultVariants: { color: "primary" },
  },
);

export type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> &
  VariantProps<typeof checkboxVariants>;

export function Checkbox({ className, color, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root className={cn(checkboxVariants({ color }), className)} {...props}>
      <CheckboxPrimitive.Indicator>
        {props.checked === "indeterminate" ? (
          <IconMinus className="size-3.5 stroke-[2.5]" />
        ) : (
          <IconCheck className="size-3.5 stroke-[2.5]" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function CheckboxField({
  id,
  label,
  reverse,
  className,
  ...props
}: CheckboxProps & { id: string; label: React.ReactNode; reverse?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2", reverse && "flex-row-reverse justify-end", className)}>
      <Checkbox id={id} {...props} />
      <label htmlFor={id} className="text-[0.9375rem] text-heading">
        {label}
      </label>
    </div>
  );
}
