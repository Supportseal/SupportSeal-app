"use client";

import { usePathname } from "next/navigation";

/**
 * The thread pane. At ≥ lg it always shows (children, or the empty
 * placeholder from the /inbox page). Below lg it takes over the screen when
 * a conversation is open, hiding the list.
 */
export function ThreadSlot({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const conversationOpen = pathname !== "/inbox";

  return (
    <div
      className={
        conversationOpen
          ? "flex min-w-0 flex-1 flex-col lg:border-l lg:border-border"
          : "hidden min-w-0 flex-1 flex-col lg:flex lg:border-l lg:border-border"
      }
    >
      {children}
    </div>
  );
}
