import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        solid:
          "disabled:pointer-events-none disabled:bg-hover disabled:text-muted disabled:shadow-none",
        label: "",
        outline: "border bg-transparent",
        text: "bg-transparent",
      },
      color: {
        primary: "",
        secondary: "",
        success: "",
        danger: "",
        warning: "",
        info: "",
        dark: "",
      },
      size: {
        xs: "h-[26px] px-2 text-[0.75rem] rounded-md",
        sm: "h-8 px-3.5 text-[0.8125rem] rounded-md",
        md: "h-[38px] px-5 text-[0.9375rem] rounded-md",
        lg: "h-11 px-6 text-base rounded-lg",
        xl: "h-[50px] px-7 text-lg rounded-lg",
      },
      rounded: {
        default: "",
        full: "rounded-full",
      },
      iconOnly: {
        true: "px-0",
        false: "",
      },
    },
    compoundVariants: [
      { iconOnly: true, size: "xs", class: "w-[26px]" },
      { iconOnly: true, size: "sm", class: "w-8" },
      { iconOnly: true, size: "md", class: "w-[38px]" },
      { iconOnly: true, size: "lg", class: "w-11" },
      { iconOnly: true, size: "xl", class: "w-[50px]" },

      { variant: "solid", color: "primary", class: "bg-primary text-primary-contrast hover:bg-primary-dark shadow-[0_2px_4px_color-mix(in_srgb,var(--vx-primary)_35%,transparent)] dark:shadow-none" },
      { variant: "solid", color: "secondary", class: "bg-secondary text-secondary-contrast hover:bg-secondary-dark" },
      { variant: "solid", color: "success", class: "bg-success text-success-contrast hover:bg-success-dark shadow-[0_2px_4px_color-mix(in_srgb,var(--vx-success)_35%,transparent)] dark:shadow-none" },
      { variant: "solid", color: "danger", class: "bg-danger text-danger-contrast hover:bg-danger-dark shadow-[0_2px_4px_color-mix(in_srgb,var(--vx-danger)_35%,transparent)] dark:shadow-none" },
      { variant: "solid", color: "warning", class: "bg-warning text-warning-contrast hover:bg-warning-dark shadow-[0_2px_4px_color-mix(in_srgb,var(--vx-warning)_35%,transparent)] dark:shadow-none" },
      { variant: "solid", color: "info", class: "bg-info text-info-contrast hover:bg-info-dark shadow-[0_2px_4px_color-mix(in_srgb,var(--vx-info)_35%,transparent)] dark:shadow-none" },
      { variant: "solid", color: "dark", class: "bg-dark text-dark-contrast hover:opacity-90" },

      { variant: "label", color: "primary", class: "bg-primary-label text-primary hover:bg-primary hover:text-primary-contrast" },
      { variant: "label", color: "secondary", class: "bg-secondary-label text-secondary hover:bg-secondary hover:text-secondary-contrast" },
      { variant: "label", color: "success", class: "bg-success-label text-success hover:bg-success hover:text-success-contrast" },
      { variant: "label", color: "danger", class: "bg-danger-label text-danger hover:bg-danger hover:text-danger-contrast" },
      { variant: "label", color: "warning", class: "bg-warning-label text-warning hover:bg-warning hover:text-warning-contrast" },
      { variant: "label", color: "info", class: "bg-info-label text-info hover:bg-info hover:text-info-contrast" },
      { variant: "label", color: "dark", class: "bg-dark-label text-dark hover:bg-dark hover:text-dark-contrast" },

      { variant: "outline", color: "primary", class: "border-primary text-primary hover:bg-primary hover:text-primary-contrast" },
      { variant: "outline", color: "secondary", class: "border-secondary text-secondary hover:bg-secondary hover:text-secondary-contrast" },
      { variant: "outline", color: "success", class: "border-success text-success hover:bg-success hover:text-success-contrast" },
      { variant: "outline", color: "danger", class: "border-danger text-danger hover:bg-danger hover:text-danger-contrast" },
      { variant: "outline", color: "warning", class: "border-warning text-warning hover:bg-warning hover:text-warning-contrast" },
      { variant: "outline", color: "info", class: "border-info text-info hover:bg-info hover:text-info-contrast" },
      { variant: "outline", color: "dark", class: "border-dark text-dark hover:bg-dark hover:text-dark-contrast" },

      { variant: "text", color: "primary", class: "text-primary hover:bg-primary-label" },
      { variant: "text", color: "secondary", class: "text-secondary hover:bg-secondary-label" },
      { variant: "text", color: "success", class: "text-success hover:bg-success-label" },
      { variant: "text", color: "danger", class: "text-danger hover:bg-danger-label" },
      { variant: "text", color: "warning", class: "text-warning hover:bg-warning-label" },
      { variant: "text", color: "info", class: "text-info hover:bg-info-label" },
      { variant: "text", color: "dark", class: "text-dark hover:bg-dark-label" },
    ],
    defaultVariants: {
      variant: "solid",
      color: "primary",
      size: "md",
      rounded: "default",
      iconOnly: false,
    },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  color,
  size,
  rounded,
  iconOnly,
  asChild,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      {...(asChild ? {} : { type })}
      data-slot="button"
      className={cn(buttonVariants({ variant, color, size, rounded, iconOnly }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
