"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { deliverAgentReplyIfRouted } from "@/lib/email/routing";

import {
  addAgentMessage,
  setConversationStatus,
  tagConversation,
  untagConversation,
} from "@/lib/conversations";
import { createSavedReply } from "@/lib/saved-replies";
import { requireWorkspace } from "@/lib/workspace";

const MESSAGE_KINDS = ["AGENT", "NOTE"] as const;
const CONVERSATION_STATUSES = ["OPEN", "PENDING", "CLOSED"] as const;

function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}

export async function sendMessageAction(input: {
  conversationId: string;
  body: string;
  kind: string;
  attachmentIds?: string[];
}): Promise<{ error?: string }> {
  if (!isOneOf(input.kind, MESSAGE_KINDS)) {
    return { error: "Invalid message kind." };
  }
  const ctx = await requireWorkspace(`/inbox/${input.conversationId}`);
  const result = await addAgentMessage({
    ctx,
    conversationId: input.conversationId,
    body: input.body,
    kind: input.kind,
    attachmentIds: input.attachmentIds,
  });
  if (!result.ok) return { error: result.error };
  if (input.kind === "AGENT") {
    const messageId = result.messageId;
    const workspaceId = ctx.workspace.id;
    const conversationId = input.conversationId;
    // Best-effort email continuation (routing rule D5) after the response —
    // SMTP latency never blocks the inbox. Failures are recorded on the
    // delivery ledger and never block the chat thread.
    after(async () => {
      await deliverAgentReplyIfRouted({ workspaceId, conversationId, messageId }).catch(() => undefined);
      revalidatePath(`/inbox/${conversationId}`);
    });
  }
  revalidatePath(`/inbox/${input.conversationId}`);
  revalidatePath("/inbox");
  return {};
}

export async function setStatusAction(input: {
  conversationId: string;
  status: string;
}): Promise<{ error?: string }> {
  if (!isOneOf(input.status, CONVERSATION_STATUSES)) {
    return { error: "Invalid status." };
  }
  const ctx = await requireWorkspace(`/inbox/${input.conversationId}`);
  const result = await setConversationStatus({
    ctx,
    conversationId: input.conversationId,
    status: input.status,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/inbox/${input.conversationId}`);
  revalidatePath("/inbox");
  return {};
}

export async function addTagAction(input: { conversationId: string; name: string }): Promise<{ error?: string }> {
  const ctx = await requireWorkspace(`/inbox/${input.conversationId}`);
  const result = await tagConversation({
    ctx,
    conversationId: input.conversationId,
    name: input.name,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/inbox/${input.conversationId}`);
  return {};
}

export async function removeTagAction(input: { conversationId: string; tagId: string }): Promise<{ error?: string }> {
  const ctx = await requireWorkspace(`/inbox/${input.conversationId}`);
  const result = await untagConversation({
    ctx,
    conversationId: input.conversationId,
    tagId: input.tagId,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/inbox/${input.conversationId}`);
  return {};
}

/**
 * Save-reply-from-composer (issue #200): create a saved reply from the
 * current draft. Never touches the draft's conversation — the composer keeps
 * its text; the new reply is offered once the route refreshes.
 */
export async function saveReplyFromComposerAction(input: {
  name: string;
  body: string;
  productIds?: string[];
}): Promise<{ error?: string }> {
  const ctx = await requireWorkspace("/inbox");
  const result = await createSavedReply({
    ctx,
    name: input.name,
    body: input.body,
    productIds: input.productIds ?? [],
  });
  revalidatePath("/saved-replies");
  return result.ok ? {} : { error: result.error };
}
