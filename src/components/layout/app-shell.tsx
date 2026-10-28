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
  usageWarning?: UsageWarning | null;
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
        {usageWarning ? <UsageBanner warning={usageWarning} /> : null}
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

type UsageWarning = {
  conversationsOpened: number;
  limit: number | null;
  graceRemainingDays: number;
  /** Free: chat and replies pause when grace ends (src/lib/service-pause.ts). */
  pausesAfterGrace: boolean;
  paused: boolean;
};

function UsageBanner({ warning }: { warning: UsageWarning }) {
  const days = `${warning.graceRemainingDays} ${warning.graceRemainingDays === 1 ? "day" : "days"}`;
  if (warning.paused) {
    return (
      <div
        role="alert"
        className="border-b border-border bg-danger-label px-4 py-2 text-sm text-danger"
      >
        Chat and replies are paused: this workspace went over its Free plan allowance. Your chat
        widget isn&apos;t taking new messages and replies can&apos;t be sent until you upgrade.
        Customer emails are still saved.{" "}
        <a href="/settings/billing" className="font-medium underline">
          Upgrade to resume
        </a>
      </div>
    );
  }
  return (
    <div className="border-b border-border bg-warning-label px-4 py-2 text-sm text-warning">
      {warning.conversationsOpened} conversations this period
      {warning.limit !== null ? ` (limit ${warning.limit})` : ""} —{" "}
      {warning.pausesAfterGrace
        ? `chat and replies pause in ${days} unless you upgrade.`
        : `customer messages keep flowing; grace ends in ${days}.`}{" "}
      <a href="/settings/billing" className="font-medium underline">
        {warning.pausesAfterGrace ? "Upgrade" : "Review usage"}
      </a>
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
