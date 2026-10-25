import { cn } from "@/lib/cn";
import { Breadcrumb } from "@/components/ui/breadcrumb";

export function PageHeader({
  title,
  breadcrumb,
  actions,
  className,
}: {
  title: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-center justify-between gap-3", className)}>
      <div>
        <h4 className="text-[1.375rem] font-medium text-heading">{title}</h4>
        {breadcrumb ? <Breadcrumb className="mt-1" items={breadcrumb} /> : null}
      </div>
      {actions}
    </div>
  );
}
