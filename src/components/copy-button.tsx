"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";

/** Copy affordance: idle → "Copied" (2.5s) → idle; shows the failed label on error. */
export function CopyButton({
  value,
  label = "Copy",
  failedLabel = "Copy failed",
  size = "sm",
  variant = "outline",
}: {
  value: string;
  label?: string;
  failedLabel?: string;
  size?: "xs" | "sm" | "md";
  variant?: "outline" | "text" | "solid" | "label";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={handleCopy}>
      {state === "copied" ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
      {state === "copied" ? "Copied" : state === "failed" ? failedLabel : label}
    </Button>
  );
}
