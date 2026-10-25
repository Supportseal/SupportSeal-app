"use server";

import { redirect } from "next/navigation";

import { createWorkspace } from "@/lib/workspace";
import { requireUser } from "@/lib/session";

export type CreateWorkspaceState = { error?: string };

export async function createWorkspaceAction(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await requireUser("/onboarding/create-workspace");
  const name = String(formData.get("name") ?? "");
  const result = await createWorkspace({ userId: user.id, name });
  if (!result.ok) {
    return { error: result.error };
  }
  redirect("/inbox");
}
