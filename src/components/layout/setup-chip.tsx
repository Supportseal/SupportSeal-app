import Link from "next/link";

import { cn } from "@/lib/cn";

export type SetupChecklist = {
  items: Array<{ id: string; title: string; done: boolean; required: boolean }>;
  doneCount: number;
  total: number;
};

export function SetupChip({
  checklist,
  collapsed,
  onNavigate,
}: {
  checklist: SetupChecklist;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const outstanding = checklist.items.filter((item) => !item.done);
  if (!outstanding.some((item) => item.required)) return null;
  const [next] = outstanding;

  return (
    <div className={cn("px-2 pb-3", collapsed && "lg:px-1.5")}>
      <Link
        href="/settings/setup"
        onClick={onNavigate}
        title={`Next: ${next.title}`}
        aria-label={`Setup ${checklist.doneCount} of ${checklist.total} complete. Next: ${next.title}`}
        className={cn(
          "flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2 text-[0.875rem] text-body transition-colors hover:bg-hover hover:text-heading",
          collapsed && "lg:justify-center lg:px-0",
        )}
      >
        <span className="relative flex size-5 items-center justify-center">
          <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
            <circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--vx-border-strong)" strokeWidth="2" />
            <circle
              cx="10"
              cy="10"
              r="8.5"
              fill="none"
              stroke="var(--vx-primary)"
              strokeWidth="2"
              strokeDasharray={`${(checklist.doneCount / checklist.total) * 53.4} 53.4`}
              transform="rotate(-90 10 10)"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={cn("truncate", collapsed && "lg:hidden")}>
          Setup {checklist.doneCount}/{checklist.total}
        </span>
      </Link>
    </div>
  );
}
