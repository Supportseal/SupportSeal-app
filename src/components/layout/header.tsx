"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import {
  IconBell,
  IconLogout,
  IconMenu2,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import { toast } from "sonner";

import { useLayout } from "@/components/layout/layout-provider";
import { AvailabilityControl, type Availability } from "@/components/layout/availability-control";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { resetSupportWidget } from "@/lib/support-widget-session";
import {
  useNotificationPreference,
  useNotificationSupport,
} from "@/lib/notifications/client";
import { useDeskSoundMuted } from "@/lib/notify-sound-client";

export type HeaderUser = { id: string; name: string; email: string };

export function Header({
  user,
  workspaceId,
  availability,
  isAdmin,
  onAvailabilityChange,
}: {
  user: HeaderUser;
  workspaceId: string;
  availability: Availability;
  isAdmin: boolean;
  onAvailabilityChange: (next: Availability) => Promise<unknown>;
}) {
  const { collapsed, toggleCollapsed, setMobileOpen } = useLayout();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Show the chosen option immediately; it settles on the server value after
  // the refresh (and reverts if the change did not stick).
  const [shownAvailability, setShownAvailability] = useOptimistic(availability);

  const [notifyEnabled, setNotifyEnabled] = useNotificationPreference(user.id, workspaceId);
  const [soundMuted, setSoundMuted] = useDeskSoundMuted(user.id, workspaceId);
  const {
    permission: notifyPermission,
    refresh: refreshNotifySupport,
    supported: notifySupported,
  } = useNotificationSupport();

  async function signOut() {
    // Queued first: the next person on this device starts a fresh support chat.
    resetSupportWidget();
    await authClient.signOut();
    router.push("/login");
  }

  // Permission may only be requested from a user gesture, so this runs from
  // the menu item's click, never from the background listener.
  async function toggleNotifications() {
    if (!notifySupported) return;
    if (notifyEnabled) {
      await setNotifyEnabled(false);
      return;
    }
    if (notifyPermission === "granted") {
      await setNotifyEnabled(true);
      return;
    }
    const result = await Notification.requestPermission();
    refreshNotifySupport();
    if (result === "granted") await setNotifyEnabled(true);
    else if (result === "denied")
      toast.error("Desktop notifications are blocked in your browser settings.");
    else toast.info("Desktop notifications stay off.");
  }

  return (
    <header className="sticky top-0 z-30 flex h-header items-center gap-2 border-b border-border bg-surface px-4">
      <button
        type="button"
        className="rounded-md p-2 text-body hover:bg-hover lg:hidden"
        onClick={() => setMobileOpen(true)}
        aria-label="Open menu"
      >
        <IconMenu2 className="size-5" />
      </button>
      <button
        type="button"
        className="hidden rounded-md p-2 text-body hover:bg-hover lg:inline-flex"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
      >
        <IconMenu2 className="size-5" />
      </button>

      <div className="ms-auto flex items-center gap-1">
        <AvailabilityControl
          availability={shownAvailability}
          isAdmin={isAdmin}
          pending={pending}
          onChange={(next) =>
            startTransition(async () => {
              setShownAvailability(next);
              await onAvailabilityChange(next);
              router.refresh();
            })
          }
        />
        <ThemeToggle />
        <DropdownMenu onOpenChange={(open) => (open ? refreshNotifySupport() : undefined)}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded-full focus-visible:outline-2 focus-visible:outline-primary"
              aria-label="Account menu"
            >
              <Avatar name={user.name} size={32} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>
              <span className="block truncate font-medium text-heading">{user.name}</span>
              <span className="block truncate text-xs font-normal text-muted">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifySupported ? (
              <>
                <DropdownMenuCheckboxItem
                  checked={notifyEnabled && notifyPermission === "granted"}
                  disabled={notifyPermission === "denied" && !notifyEnabled}
                  onSelect={(event) => {
                    event.preventDefault();
                    void toggleNotifications().catch(() =>
                      toast.error("Could not enable desktop notifications. Check browser permissions and storage."),
                    );
                  }}
                >
                  <IconBell className="size-4" />
                  Desktop notifications
                </DropdownMenuCheckboxItem>
                {notifyPermission === "denied" ? (
                  <p className="px-2 pb-1.5 text-xs text-muted">
                    Blocked in your browser settings.
                  </p>
                ) : notifyPermission === "default" ? (
                  <p className="px-2 pb-1.5 text-xs text-muted">
                    Alerts for new customer messages while a dashboard tab is open. At most one per minute.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <DropdownMenuItem disabled>
                  <IconBell className="size-4" />
                  Desktop notifications
                </DropdownMenuItem>
                <p className="px-2 pb-1.5 text-xs text-muted">Requires a supported desktop browser and HTTPS (or localhost).</p>
              </>
            )}
            <DropdownMenuCheckboxItem
              checked={!soundMuted}
              onSelect={(event) => {
                event.preventDefault();
                void setSoundMuted(!soundMuted);
              }}
            >
              {soundMuted ? <IconVolumeOff className="size-4" /> : <IconVolume className="size-4" />}
              Message sound
            </DropdownMenuCheckboxItem>
            <p className="px-2 pb-1.5 text-xs text-muted">
              A short chime when a customer message arrives.
            </p>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <IconLogout className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
