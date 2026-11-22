import Link from "next/link";
import { format } from "date-fns";
import { IconMail, IconMessageCircle } from "@tabler/icons-react";

import { cn } from "@/lib/cn";
import { ProductMark } from "@/components/product-identity";
import { Badge } from "@/components/ui/badge";
import type { ConversationHistoryItem } from "@/lib/contacts";
import { formatTicketRef } from "@/lib/ticket";

const STATUS_COLOR = { OPEN: "primary", PENDING: "warning", CLOSED: "secondary" } as const;

/**
 * A customer's conversations as links into the inbox. Used by the contact
 * page and the Conversation side panel; holds no client state, so both
 * server and client components can render it.
 */
export function ConversationHistoryList({
  items,
  showProduct,
  compact = false,
}: {
  items: ConversationHistoryItem[];
  showProduct: boolean;
  compact?: boolean;
}) {
  return (
    <ul className={cn(compact ? "space-y-1" : "divide-y divide-border rounded-lg border border-border")}>
      {items.map((item) => {
        const ChannelIcon = item.channel === "EMAIL" ? IconMail : IconMessageCircle;
        return (
          <li key={item.id}>
            <Link
              href={`/inbox/${item.id}`}
              className={cn(
                "flex min-w-0 items-start gap-2 hover:bg-hover",
                compact ? "-mx-2 rounded-md px-2 py-1.5" : "px-4 py-3",
              )}
            >
              {showProduct ? (
                <ProductMark name={item.product.name} color={item.product.primaryColor} size="sm" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  <span className="shrink-0 tabular-nums">{formatTicketRef(item.ticketNumber)}</span>
                  <ChannelIcon
                    className="size-3.5 shrink-0"
                    role="img"
                    aria-label={item.channel === "EMAIL" ? "Email" : "Chat"}
                  />
                  {showProduct ? <span className="truncate">{item.product.name}</span> : null}
                  <span className="ms-auto shrink-0">{format(new Date(item.lastMessageAt), "d MMM yyyy")}</span>
                </span>
                <span
                  className={cn(
                    "mt-0.5 block text-sm text-heading [overflow-wrap:anywhere]",
                    compact ? "line-clamp-2" : "truncate",
                  )}
                >
                  {item.title || <span className="text-muted">No message</span>}
                </span>
              </span>
              <Badge variant="light" color={STATUS_COLOR[item.status]} className="shrink-0 px-2 text-xs">
                {item.status.toLowerCase()}
              </Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
