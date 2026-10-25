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
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 p-3">
          <pre className="min-w-0 flex-1 overflow-x-auto text-xs leading-relaxed">
            <code>{snippet}</code>
          </pre>
          <Button type="button" variant="outline" size="sm" onClick={() => copy(snippet, "snippet")}>
            {copied === "snippet" ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
            {copied === "snippet" ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Widget key:</span>
          <code className="font-mono">{widgetKey}</code>
          <Button type="button" variant="text" size="xs" onClick={() => copy(widgetKey, "key")}>
            {copied === "key" ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
            {copied === "key" ? "Copied" : "Copy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
