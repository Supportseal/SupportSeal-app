import Link from "next/link";
import { IconCheck, IconCircle } from "@tabler/icons-react";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ChecklistState } from "@/lib/onboarding";

export function SetupChecklistView({ checklist }: { checklist: ChecklistState }) {
  const complete = checklist.doneCount === checklist.total;

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted">
            {complete ? "You're set up" : "Get set up"} · {checklist.doneCount} of {checklist.total} complete
          </h3>
          <Progress value={(checklist.doneCount / checklist.total) * 100} />
        </div>
        <ol className="divide-y divide-border">
          {checklist.items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-3">
              {item.done ? (
                <IconCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              ) : (
                <IconCircle className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
              )}
              {item.done ? (
                <p className="text-sm text-muted line-through">
                  {item.title}
                  <span className="sr-only"> (completed)</span>
                </p>
              ) : (
                <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-heading">{item.title}</p>
                    <p className="mt-0.5 text-sm text-muted">{item.hint}</p>
                  </div>
                  <Link
                    href={item.actionHref}
                    className="inline-flex h-9 shrink-0 items-center rounded-md border border-border-strong px-3 text-sm font-medium text-heading hover:bg-hover"
                  >
                    {item.actionLabel}
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
