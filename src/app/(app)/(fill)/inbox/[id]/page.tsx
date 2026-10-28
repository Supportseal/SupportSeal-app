import { notFound } from "next/navigation";

import { countFailedOutboundDeliveries, getConversationDetail, listTags } from "@/lib/conversations";
import { orderContextForDisplay } from "@/lib/dev-context";
import { hasExpiredSnapshotsForConversation, listSnapshotsForConversation } from "@/lib/diagnostics/store";
import { listActiveProducts } from "@/lib/products";
import { listSavedRepliesForProduct, savedReplyProductNames } from "@/lib/saved-replies";
import { isServicePaused } from "@/lib/service-pause";
import { requireWorkspace } from "@/lib/workspace";
import { ConversationView } from "./conversation-view";

export const metadata = { title: "Conversation" };

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireWorkspace(`/inbox/${id}`);

  const [conversation, tags, failedDeliveries] = await Promise.all([
    getConversationDetail({ workspaceId: ctx.workspace.id, conversationId: id }),
    listTags(ctx.workspace.id),
    countFailedOutboundDeliveries(id),
  ]);
  if (!conversation) notFound();

  // A reply is offered when it is All-products or includes this Product.
  const [savedReplies, snapshots, hasExpired, products, repliesPaused] = await Promise.all([
    listSavedRepliesForProduct(ctx.workspace.id, conversation.product.id),
    listSnapshotsForConversation(ctx.workspace.id, conversation.id),
    hasExpiredSnapshotsForConversation(ctx.workspace.id, conversation.id),
    listActiveProducts(ctx.workspace.id),
    isServicePaused(ctx.workspace.id),
  ]);

  return (
    <ConversationView
      conversation={{
        id: conversation.id,
        ticketNumber: conversation.ticketNumber,
        status: conversation.status,
        channel: conversation.channel,
        subject: conversation.subject,
        createdAt: conversation.createdAt.toISOString(),
        contact: {
          id: conversation.contact.id,
          name: conversation.contact.name,
          email: conversation.contact.email,
        },
        visitorEmail: conversation.chatVisitors[0]?.email ?? null,
        product: {
          id: conversation.product.id,
          name: conversation.product.name,
          primaryColor: conversation.product.primaryColor,
        },
        productArchived: conversation.product.archivedAt !== null,
        tags: conversation.tags.map((t) => ({ id: t.tagId, name: t.tag.name })),
        messages: conversation.messages.map((message) => ({
          id: message.id,
          kind: message.kind,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
          authorName: message.author?.name ?? null,
          channel: message.channel,
          attachments: message.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })),
        })),
      }}
      availableTags={tags}
      savedReplies={savedReplies.map((r) => ({
        id: r.id,
        name: r.name,
        body: r.body,
        productNames: savedReplyProductNames(r),
      }))}
      canManageSavedReplies={ctx.role === "ADMIN"}
      savedReplyProducts={
        ctx.role === "ADMIN"
          ? products.map((product) => ({ id: product.id, name: product.name }))
          : []
      }
      failedDeliveryCount={failedDeliveries}
      repliesPaused={repliesPaused}
      devContext={{
        identifiedUserId: conversation.chatVisitors[0]?.externalUserId ?? null,
        entries: orderContextForDisplay(
          (conversation.chatVisitors[0]?.devContext as Record<string, unknown> | null) ?? {},
        ).map((entry) => ({
          key: entry.key,
          value:
            typeof entry.value === "object" && entry.value !== null
              ? JSON.stringify(entry.value)
              : String(entry.value ?? ""),
          updatedAt: ((conversation.chatVisitors[0]?.devContext as Record<string, unknown> | null)
            ?.updatedAt as string | undefined) ?? null,
        })),
      }}
      diagnostics={{
        enabled: conversation.product.diagnosticsEnabledAt !== null,
        hasExpired,
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id,
          messageId: snapshot.messageId,
          createdAt: snapshot.createdAt.toISOString(),
          errorCount: snapshot.errorCount,
          warningCount: snapshot.warningCount,
          networkFailureCount: snapshot.networkFailureCount,
          droppedCount: snapshot.droppedCount,
          environment: snapshot.environment,
          events: snapshot.events,
        })),
      }}
    />
  );
}
