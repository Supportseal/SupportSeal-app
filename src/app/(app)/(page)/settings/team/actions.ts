"use server";

import { revalidatePath } from "next/cache";

import { appConfig } from "@/lib/config";
import { requireWorkspace } from "@/lib/workspace";
import { createInvite, revokeInvite, type MembershipRole } from "@/lib/workspace";

export type InviteActionResult = { error?: string; inviteUrl?: string };

export async function createInviteAction(
  _prev: InviteActionResult,
  formData: FormData,
): Promise<InviteActionResult> {
  const ctx = await requireWorkspace("/settings/team");
  const email = String(formData.get("email") ?? "");
  const role = formData.get("role") === "ADMIN" ? "ADMIN" : "AGENT";
  const result = await createInvite({
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    actorRole: ctx.role,
    email,
    role: role as MembershipRole,
  });
  revalidatePath("/settings/team");
  if (!result.ok) {
    return { error: result.error };
  }
  return { inviteUrl: `${appConfig.url}/invite/${result.token}` };
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/settings/team");
  const inviteId = String(formData.get("inviteId") ?? "");
  await revokeInvite({ workspaceId: ctx.workspace.id, actorRole: ctx.role, inviteId });
  revalidatePath("/settings/team");
}
