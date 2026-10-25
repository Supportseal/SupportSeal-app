"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const switchVariants = cva(
  "peer inline-flex shrink-0 cursor-pointer items-center border-2 border-transparent transition-colors focus-visible:shadow-[0_0_0_0.15rem_var(--vx-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "h-4 w-7",
        md: "h-[1.375rem] w-10",
        lg: "h-6 w-12",
      },
      shape: {
        rounded: "rounded-full",
        square: "rounded-[4px]",
      },
      color: {
        primary: "bg-border-strong data-[state=checked]:bg-primary",
        secondary: "bg-border-strong data-[state=checked]:bg-secondary",
        success: "bg-border-strong data-[state=checked]:bg-success",
        danger: "bg-border-strong data-[state=checked]:bg-danger",
        warning: "bg-border-strong data-[state=checked]:bg-warning",
        info: "bg-border-strong data-[state=checked]:bg-info",
        dark: "bg-border-strong data-[state=checked]:bg-dark",
      },
    },
    defaultVariants: {
      size: "md",
      shape: "rounded",
      color: "primary",
    },
  },
);

const thumbSize = {
  sm: "size-3 data-[state=checked]:translate-x-3",
  md: "size-[1.125rem] data-[state=checked]:translate-x-[1.125rem]",
  lg: "size-5 data-[state=checked]:translate-x-6",
};

export type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> &
  VariantProps<typeof switchVariants>;

export function Switch({ className, size, shape, color, ...props }: SwitchProps) {
  const resolvedSize = size ?? "md";
  return (
    <SwitchPrimitive.Root
      className={cn(switchVariants({ size: resolvedSize, shape, color }), className)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block rounded-[inherit] bg-white shadow-sm transition-transform data-[state=unchecked]:translate-x-0",
          thumbSize[resolvedSize],
        )}
      />
    </SwitchPrimitive.Root>
  );
}
