import Link from "next/link";
import { IconMessageOff } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Unknown, foreign and deleted Conversations all look the same (FR-SEC-01):
 * an agent whose open thread was just deleted by an Admin lands here too.
 */
export default function ConversationNotFound() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center">
      <EmptyState
        icon={IconMessageOff}
        title="Conversation not found"
        description="It may have been deleted, or the link is wrong."
        action={
          <Button asChild variant="outline" color="secondary" size="sm">
            <Link href="/inbox">Back to inbox</Link>
          </Button>
        }
      />
    </div>
  );
}
