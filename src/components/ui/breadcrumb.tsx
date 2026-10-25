import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { cn } from "@/lib/cn";

export function Breadcrumb({
  items,
  className,
}: {
  items: { label: string; href?: string }[];
  className?: string;
}) {
  return (
    <nav className={cn("flex flex-wrap items-center gap-1 text-[0.9375rem]", className)}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 ? <IconChevronRight className="size-3.5 text-muted" /> : null}
            {item.href && !last ? (
              <Link href={item.href} className="text-muted hover:text-primary">
                {item.label}
              </Link>
            ) : (
              <span className={last ? "text-heading" : "text-muted"}>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
