"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function WidgetSnippet({ snippet, widgetKey }: { snippet: string; widgetKey: string }) {
  const [copied, setCopied] = useState<"snippet" | "key" | null>(null);

  async function copy(value: string, which: "snippet" | "key") {
    await navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <div>
          <h2 className="text-lg font-medium text-heading">Chat widget embed</h2>
          <p className="mt-1 text-sm text-muted">
            Paste this just before <code>&lt;/body&gt;</code> on every page where the widget should
            appear. The key is public — it identifies the Product and grants no privileged access.
          </p>
        </div>
        <div className="relative flex items-center gap-2 overflow-hidden rounded-md border border-ink-rule bg-brand-ink p-3 text-mint-100 dark:border-border">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand-mint" />
          <pre className="min-w-0 flex-1 overflow-x-auto text-xs leading-relaxed">
            <code>{snippet}</code>
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-mint-100/30 text-mint-100 hover:border-mint-100 hover:bg-transparent hover:text-white"
            onClick={() => copy(snippet, "snippet")}
          >
            {copied === "snippet" ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
            {copied === "snippet" ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-muted">Widget key:</span>
          <code className="min-w-0 break-all font-mono">{widgetKey}</code>
          <Button type="button" variant="text" size="xs" onClick={() => copy(widgetKey, "key")}>
            {copied === "key" ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
            {copied === "key" ? "Copied" : "Copy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
