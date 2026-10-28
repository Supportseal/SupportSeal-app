"use client";

import { cn } from "@/lib/cn";
import { Header } from "@/components/layout/header";
import { type Availability } from "@/components/layout/availability-control";
import { LayoutProvider, useLayout } from "@/components/layout/layout-provider";
import { InboxSoundListener } from "@/components/layout/inbox-sound-listener";
import { NotificationListener } from "@/components/layout/notification-listener";
import { type SetupChecklist } from "@/components/layout/setup-chip";
import { Sidebar, type SidebarProduct } from "@/components/layout/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnreadTitle } from "@/components/layout/unread-title";
import { useVisibleViewportHeight } from "@/components/layout/use-visible-viewport-height";

export type ShellUser = { id: string; name: string; email: string };

function Shell({
  user,
  workspaceId,
  role,
  products,
  availability,
  onAvailabilityChange,
  mode = "page",
  checklist,
  usageWarning = null,
  children,
}: {
  user: ShellUser;
  workspaceId: string;
  role: "ADMIN" | "AGENT";
  products: SidebarProduct[];
  availability: Availability;
  onAvailabilityChange: (next: Availability) => Promise<unknown>;
  mode?: "page" | "fill";
  checklist?: SetupChecklist | null;
  usageWarning?: { conversationsOpened: number; limit: number | null; graceRemainingDays: number } | null;
  children: React.ReactNode;
}) {
  const { collapsed, mobileOpen, setMobileOpen } = useLayout();
  const fill = mode === "fill";
  useVisibleViewportHeight(fill);

  return (
    // Fill mode (the inbox) is exactly one visible screen tall: the header,
    // any banner and the page share it, so nothing (like the reply box) can
    // end up below the fold or under a phone keyboard.
    <div
      className={cn(
        "bg-body-bg",
        fill ? "h-[var(--app-viewport-height,100dvh)] overflow-hidden" : "min-h-screen",
      )}
    >
      <UnreadTitle />
      <Sidebar
        products={products}
        role={role}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        checklist={checklist}
      />
      <div
        className={cn(
          "flex flex-col transition-[margin] duration-200",
          fill ? "h-full" : "min-h-screen",
          collapsed ? "lg:ms-sidebar-collapsed" : "lg:ms-sidebar",
        )}
      >
        <Header
          user={user}
          workspaceId={workspaceId}
          availability={availability}
          isAdmin={role === "ADMIN"}
          onAvailabilityChange={onAvailabilityChange}
        />
        <NotificationListener userId={user.id} workspaceId={workspaceId} />
        <InboxSoundListener userId={user.id} workspaceId={workspaceId} />
        {usageWarning ? (
          <div className="border-b border-border bg-warning-label px-4 py-2 text-sm text-warning">
            {usageWarning.conversationsOpened} conversations this period
            {usageWarning.limit !== null ? ` (limit ${usageWarning.limit})` : ""} — customer
            messages keep flowing; grace ends in {usageWarning.graceRemainingDays} days.{" "}
            <a href="/settings/billing" className="font-medium underline">
              Review usage
            </a>
          </div>
        ) : null}
        <main
          id="main"
          className={cn(
            fill ? "min-h-0 flex-1 overflow-hidden" : "flex-1 px-4 py-6 lg:px-6",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppShell(props: Parameters<typeof Shell>[0]) {
  return (
    <LayoutProvider>
      <TooltipProvider delayDuration={200}>
        <Shell {...props} />
      </TooltipProvider>
    </LayoutProvider>
  );
}
