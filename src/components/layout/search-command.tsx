"use client";

import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { IconSearch } from "@tabler/icons-react";
import { searchablePages } from "@/config/menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function SearchCommand({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command
          className="bg-surface"
          onKeyDown={(event) => {
            if (event.key === "Escape") onOpenChange(false);
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-4">
            <IconSearch className="size-4 text-muted" />
            <Command.Input
              autoFocus
              placeholder="Search pages..."
              className="h-12 w-full bg-transparent text-[0.9375rem] text-heading outline-none placeholder:text-muted"
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-8 text-center text-sm text-muted">
              No pages found.
            </Command.Empty>
            {searchablePages.map((page) => (
              <Command.Item
                key={page.href}
                value={page.label}
                onSelect={() => {
                  onOpenChange(false);
                  router.push(page.href);
                }}
                className="cursor-pointer rounded-md px-3 py-2 text-[0.9375rem] text-heading data-[selected=true]:bg-primary-label data-[selected=true]:text-primary"
              >
                {page.label}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
