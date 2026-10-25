"use client";

import { useCallback, useRef } from "react";
import {
  IconBold,
  IconItalic,
  IconUnderline,
  IconList,
  IconListNumbers,
  IconLink,
} from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

const starter =
  "<p>Cupcake ipsum dolor sit amet. Halvah cheesecake chocolate bar gummi bears cupcake. Pie macaroon bear claw. Soufflé I love candy canes I love cotton candy I love.</p>";

const commandIcons = {
  bold: IconBold,
  italic: IconItalic,
  underline: IconUnderline,
  insertUnorderedList: IconList,
  insertOrderedList: IconListNumbers,
  createLink: IconLink,
} as const;

const snowCommands = ["bold", "italic", "underline"] as const;
const fullCommands = [...snowCommands, "insertUnorderedList", "insertOrderedList", "createLink"] as const;

export function RichEditor({
  variant = "snow",
  className,
}: {
  variant?: "snow" | "bubble" | "full";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const exec = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    ref.current?.focus();
  }, []);

  const commands = variant === "full" ? fullCommands : snowCommands;
  const toolbar = (
    <div
      className={cn(
        "flex flex-wrap gap-1",
        variant === "bubble"
          ? "absolute -top-11 left-4 rounded-md border border-border bg-surface p-1 shadow-menu"
          : "border-b border-border p-2",
      )}
    >
      {commands.map((command) => {
        const Icon = commandIcons[command];
        return (
          <Button
            key={command}
            size="sm"
            variant="text"
            color="secondary"
            iconOnly
            aria-label={command}
            onClick={() => {
              if (command === "createLink") {
                const url = window.prompt("URL", "https://");
                if (url) exec(command, url);
                return;
              }
              exec(command);
            }}
          >
            <Icon className="size-4" />
          </Button>
        );
      })}
    </div>
  );

  return (
    <div className={cn("relative rounded-lg border border-border bg-surface", className)}>
      {toolbar}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        className="min-h-40 px-4 py-3 text-[0.9375rem] text-heading outline-none [&_p]:mb-2"
        dangerouslySetInnerHTML={{ __html: starter }}
      />
    </div>
  );
}
