import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { IconArrowLeft } from "@tabler/icons-react";

import { ConversationHistoryList } from "@/components/conversation-history-list";
import { visitorLabel } from "@/lib/contact-label";
import { CONTACT_CONVERSATIONS_SHOWN, getContactHistory } from "@/lib/contacts";
import { requireWorkspace } from "@/lib/workspace";

import { ContactBlockControls } from "./block-controls";

export const metadata = { title: "Contact" };

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireWorkspace(`/contacts/${id}`);
  // Another Workspace's contact id is indistinguishable from an unknown one.
  const history = await getContactHistory({ workspaceId: ctx.workspace.id, contactId: id });
  if (!history) notFound();
  const { contact, conversations, total } = history;
  const blocked = contact.blockedAt !== null;
  const blockControls = (
    <ContactBlockControls
      contactId={contact.id}
      label={visitorLabel(contact)}
      blocked={blocked}
      hasConversations={total > 0}
    />
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <Link href="/contacts" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <IconArrowLeft className="size-4" />
        Contacts
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-heading [overflow-wrap:anywhere]">{visitorLabel(contact)}</h1>
          <p className="mt-1 text-body [overflow-wrap:anywhere]">
            {contact.email ?? <span className="text-muted">No email address</span>}
          </p>
          <p className="mt-1 text-sm text-muted">
            First contact {format(contact.createdAt, "d MMM yyyy")} · {total}{" "}
            {total === 1 ? "conversation" : "conversations"}
          </p>
        </div>
        {blocked ? null : blockControls}
      </header>
      {blocked ? blockControls : null}

      <section className="space-y-2">
        <h2 className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">Conversations</h2>
        {conversations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            No conversations with this contact.
          </p>
        ) : (
          <ConversationHistoryList items={conversations} showProduct />
        )}
        {total > CONTACT_CONVERSATIONS_SHOWN ? (
          <p className="text-sm text-muted">
            Showing the {CONTACT_CONVERSATIONS_SHOWN} most recent. Search the inbox for older ones.
          </p>
        ) : null}
      </section>
    </div>
  );
}
