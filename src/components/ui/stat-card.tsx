import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  title,
  value,
  change,
  subtitle,
  icon,
  iconClass,
}: {
  title: string;
  value: string;
  change: number;
  subtitle: string;
  icon: React.ReactNode;
  iconClass?: string;
}) {
  const up = change >= 0;
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[1.375rem] font-medium text-heading">{value}</h4>
            <Badge color={up ? "success" : "danger"}>{up ? `+${change}%` : `${change}%`}</Badge>
          </div>
          <p className="mt-1 text-[0.9375rem] text-heading">{title}</p>
          <p className="text-[0.8125rem] text-muted">{subtitle}</p>
        </div>
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-md", iconClass)}>
          {icon}
        </span>
      </CardContent>
    </Card>
  );
}
