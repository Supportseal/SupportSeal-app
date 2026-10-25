"use client";

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

export function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn("grid gap-2", className)} {...props} />;
}

const radioVariants = cva(
  "size-[1.125rem] rounded-full border bg-surface focus-visible:shadow-[0_0_0_0.15rem_var(--vx-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      color: {
        primary: "border-muted data-[state=checked]:border-primary data-[state=checked]:border-[5px]",
        secondary: "border-muted data-[state=checked]:border-secondary data-[state=checked]:border-[5px]",
        success: "border-muted data-[state=checked]:border-success data-[state=checked]:border-[5px]",
        danger: "border-muted data-[state=checked]:border-danger data-[state=checked]:border-[5px]",
        warning: "border-muted data-[state=checked]:border-warning data-[state=checked]:border-[5px]",
        info: "border-muted data-[state=checked]:border-info data-[state=checked]:border-[5px]",
        dark: "border-muted data-[state=checked]:border-dark data-[state=checked]:border-[5px]",
      },
    },
    defaultVariants: { color: "primary" },
  },
);

export type RadioGroupItemProps = React.ComponentProps<typeof RadioGroupPrimitive.Item> &
  VariantProps<typeof radioVariants>;

export function RadioGroupItem({ className, color, ...props }: RadioGroupItemProps) {
  return <RadioGroupPrimitive.Item className={cn(radioVariants({ color }), className)} {...props} />;
}

export function RadioField({
  id,
  value,
  label,
  reverse,
  color,
  className,
}: {
  id: string;
  value: string;
  label: React.ReactNode;
  reverse?: boolean;
  color?: RadioGroupItemProps["color"];
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", reverse && "flex-row-reverse justify-end", className)}>
      <RadioGroupItem value={value} id={id} color={color} />
      <label htmlFor={id} className="text-[0.9375rem] text-heading">
        {label}
      </label>
    </div>
  );
}
