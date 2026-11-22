"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { IconBan } from "@tabler/icons-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { setContactBlockedAction } from "../actions";

const CONNECTION_ERROR: { error?: string; deleted?: boolean } = {
  error: "Couldn't update the contact. Check your connection and try again.",
};

/**
 * Block or unblock this contact. Blocked: a red bar like the conversation
 * view's, with Unblock. Not blocked: a Block button. Both toast with Undo,
 * except an unblock that removed a contact with no conversations left.
 */
export function ContactBlockControls({
  contactId,
  label,
  blocked,
  hasConversations,
}: {
  contactId: string;
  label: string;
  blocked: boolean;
  hasConversations: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function setBlocked(next: boolean) {
    startTransition(async () => {
      const result = await setContactBlockedAction({ contactId, blocked: next }).catch(() => CONNECTION_ERROR);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      if (result.deleted) {
        toast(`${label} is unblocked`, {
          id: "contact-blocked",
          description: "They had no conversations left, so the contact was removed.",
        });
        router.push("/contacts");
        return;
      }
      toast(next ? `${label} is blocked` : `${label} is unblocked`, {
        id: "contact-blocked",
        description: next ? "New messages from this sender are dropped without telling them." : undefined,
        action: {
          label: "Undo",
          onClick: () => {
            void setContactBlockedAction({ contactId, blocked: !next })
              .catch(() => CONNECTION_ERROR)
              .then((undone) => {
                if (undone.error) toast.error(undone.error);
                router.refresh();
              });
          },
        },
      });
      router.refresh();
    });
  }

  if (blocked) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-label px-4 py-2 text-sm text-danger"
        data-testid="contact-blocked"
      >
        <IconBan className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          Blocked. New messages from them are dropped without telling them.
          {hasConversations ? null : " Unblocking removes this contact, because no conversations are left."}
        </span>
        <Button variant="text" color="danger" size="sm" onClick={() => setBlocked(false)} disabled={pending}>
          Unblock
        </Button>
      </div>
    );
  }

  return (
    <Button variant="label" color="secondary" size="sm" onClick={() => setBlocked(true)} disabled={pending}>
      <IconBan className="size-4" aria-hidden />
      Block sender
    </Button>
  );
}
