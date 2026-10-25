import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const cardColorKeys = ["primary", "secondary", "success", "danger", "warning", "info"] as const;

const cardVariants = cva("vx-card", {
  variants: {
    variant: {
      default: "",
      solid: "shadow-none",
      label: "shadow-none",
      outline: "border bg-transparent shadow-none",
    },
    color: {
      primary: "",
      secondary: "",
      success: "",
      danger: "",
      warning: "",
      info: "",
    },
  },
  compoundVariants: [
    { variant: "solid", color: "primary", class: "bg-primary" },
    { variant: "solid", color: "secondary", class: "bg-secondary" },
    { variant: "solid", color: "success", class: "bg-success" },
    { variant: "solid", color: "danger", class: "bg-danger" },
    { variant: "solid", color: "warning", class: "bg-warning" },
    { variant: "solid", color: "info", class: "bg-info" },

    { variant: "label", color: "primary", class: "bg-primary-label text-primary" },
    { variant: "label", color: "secondary", class: "bg-secondary-label text-secondary" },
    { variant: "label", color: "success", class: "bg-success-label text-success" },
    { variant: "label", color: "danger", class: "bg-danger-label text-danger" },
    { variant: "label", color: "warning", class: "bg-warning-label text-warning" },
    { variant: "label", color: "info", class: "bg-info-label text-info" },

    { variant: "outline", color: "primary", class: "border-primary text-primary" },
    { variant: "outline", color: "secondary", class: "border-secondary text-secondary" },
    { variant: "outline", color: "success", class: "border-success text-success" },
    { variant: "outline", color: "danger", class: "border-danger text-danger" },
    { variant: "outline", color: "warning", class: "border-warning text-warning" },
    { variant: "outline", color: "info", class: "border-info text-info" },
  ],
  defaultVariants: {
    variant: "default",
    color: "primary",
  },
});

export type CardProps = React.ComponentProps<"div"> & VariantProps<typeof cardVariants>;

export function Card({ className, variant, color, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant, color }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-start justify-between gap-4 px-6 pt-6 pb-0", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h5">) {
  return (
    <h5
      className={cn(
        "text-[1.125rem] font-medium text-heading",
        "[.text-white_&]:text-white",
        "[.text-primary_&]:text-primary",
        "[.text-secondary_&]:text-secondary",
        "[.text-success_&]:text-success",
        "[.text-danger_&]:text-danger",
        "[.text-warning_&]:text-warning",
        "[.text-info_&]:text-info",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "mt-0.5 text-[0.8125rem] text-muted",
        "[.text-white_&]:text-white/80",
        "[.text-primary_&]:text-inherit",
        "[.text-secondary_&]:text-inherit",
        "[.text-success_&]:text-inherit",
        "[.text-danger_&]:text-inherit",
        "[.text-warning_&]:text-inherit",
        "[.text-info_&]:text-inherit",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-6 pt-5 pb-6", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex items-center gap-3 border-t border-border px-6 py-4", className)} {...props} />
  );
}

export function CardImage({
  className,
  placement = "top",
  alt,
  ...props
}: React.ComponentProps<"img"> & {
  placement?: "top" | "bottom" | "overlay" | "start" | "end";
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt ?? ""}
      className={cn(
        "w-full object-cover",
        placement === "top" && "aspect-video rounded-t-[inherit]",
        placement === "bottom" && "aspect-video rounded-b-[inherit]",
        placement === "overlay" && "absolute inset-0 h-full w-full rounded-[inherit]",
        placement === "start" &&
          "h-full min-h-[12rem] shrink-0 rounded-t-[inherit] md:w-1/3 md:rounded-t-none md:rounded-s-[inherit]",
        placement === "end" &&
          "h-full min-h-[12rem] shrink-0 rounded-b-[inherit] md:w-1/3 md:rounded-b-none md:rounded-e-[inherit]",
        className,
      )}
      {...props}
    />
  );
}

export function CardOverlay({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("absolute inset-0 flex flex-col justify-end p-6", className)} {...props} />;
}

export { cardColorKeys };
