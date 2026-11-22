"use server";

import { revalidatePath } from "next/cache";

import { parseWeeklyHours } from "@/lib/business-hours";
import { requireWorkspace, saveBusinessHours } from "@/lib/workspace";

export type BusinessHoursFormState = { error?: string; saved?: boolean };

/**
 * Saves the signed-in member's own business hours. The form posts the
 * schedule as JSON (`hours`), or `enabled=off` to clear it.
 */
export async function saveBusinessHoursAction(
  _prev: BusinessHoursFormState,
  formData: FormData,
): Promise<BusinessHoursFormState> {
  const ctx = await requireWorkspace("/settings/hours");
  const enabled = formData.get("enabled") === "on";
  let hours = null;
  if (enabled) {
    try {
      hours = parseWeeklyHours(JSON.parse(String(formData.get("hours") ?? "")));
    } catch {
      hours = null;
    }
    if (!hours) return { error: "Enter a start and end time for each day you work." };
  }
  const result = await saveBusinessHours({
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    timeZone: String(formData.get("timeZone") ?? ""),
    hours,
  });
  revalidatePath("/", "layout");
  return result.ok ? { saved: true } : { error: result.error };
}
