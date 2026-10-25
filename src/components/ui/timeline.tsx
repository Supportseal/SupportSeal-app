import { cn } from "@/lib/cn";

export type TimelineItem = {
  title: string;
  description?: string;
  time: string;
  color?: "primary" | "success" | "danger" | "warning" | "info";
  extra?: React.ReactNode;
};

const dot: Record<NonNullable<TimelineItem["color"]>, string> = {
  primary: "bg-primary",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
};

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative ms-2">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="relative pb-6 ps-6 last:pb-0">
          {index < items.length - 1 ? (
            <span className="absolute top-3 left-[5px] h-full w-px bg-border" />
          ) : null}
          <span
            className={cn(
              "absolute top-1.5 left-0 size-2.5 rounded-full ring-4 ring-surface",
              dot[item.color ?? "primary"],
            )}
          />
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-heading">{item.title}</p>
              {item.description ? (
                <p className="mt-1 text-[0.8125rem] text-muted">{item.description}</p>
              ) : null}
              {item.extra}
            </div>
            <span className="shrink-0 text-[0.75rem] text-muted">{item.time}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
