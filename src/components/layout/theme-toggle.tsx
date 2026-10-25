"use client";

import { useTheme } from "next-themes";
import { IconMoon, IconSun } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";

/** Shared theme control for the app header and the marketing header/footer. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="text"
      color="secondary"
      size="sm"
      iconOnly
      className="text-body"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <IconSun className="hidden size-5 dark:block" />
      <IconMoon className="size-5 dark:hidden" />
    </Button>
  );
}
