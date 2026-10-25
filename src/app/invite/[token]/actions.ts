"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/session";
import { acceptInvite } from "@/lib/workspace";

export async function acceptInviteAction(token: string): Promise<{ error?: string }> {
  const user = await requireUser(`/invite/${token}`);
  const result = await acceptInvite({ token, userId: user.id, email: user.email });
  if (!result.ok) {
    return { error: result.error };
  }
  redirect("/inbox");
}
