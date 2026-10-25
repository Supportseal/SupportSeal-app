"use server";

import { revalidatePath } from "next/cache";

import { requireWorkspace, setAvailability } from "@/lib/workspace";

export async function setAvailabilityAction(next: "LIVE" | "AWAY"): Promise<{ error?: string }> {
  const ctx = await requireWorkspace();
  const result = await setAvailability({
    workspaceId: ctx.workspace.id,
    actorRole: ctx.role,
    availability: next,
  });
  revalidatePath("/", "layout");
  return result.ok ? {} : { error: result.error };
}
