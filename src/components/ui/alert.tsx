import { cva, type VariantProps } from "class-variance-authority";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/cn";

const alertVariants = cva("relative flex gap-3 rounded-lg px-4 py-3 text-[0.9375rem]", {
  variants: {
    color: {
      primary: "bg-primary-label text-primary",
      secondary: "bg-secondary-label text-body",
      success: "bg-success-label text-success",
      danger: "bg-danger-label text-danger",
      warning: "bg-warning-label text-warning",
      info: "bg-info-label text-info",
    },
    solid: {
      true: "",
      false: "",
    },
  },
  compoundVariants: [
    { solid: true, color: "primary", class: "bg-primary" },
    { solid: true, color: "success", class: "bg-success" },
    { solid: true, color: "danger", class: "bg-danger" },
    { solid: true, color: "warning", class: "bg-warning" },
    { solid: true, color: "info", class: "bg-info" },
    { solid: true, color: "secondary", class: "bg-secondary" },
  ],
  defaultVariants: {
    color: "primary",
    solid: false,
  },
});

export type AlertProps = React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    title?: string;
    onClose?: () => void;
    icon?: React.ReactNode;
  };

export function Alert({
  className,
  color,
  solid,
  title,
  onClose,
  icon,
  children,
  ...props
}: AlertProps) {
  return (
    <div className={cn(alertVariants({ color, solid, className }))} {...props}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium text-inherit">{title}</div> : null}
        {children ? <div className={cn(title && "mt-0.5 opacity-90")}>{children}</div> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-0.5 opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          <IconX className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
