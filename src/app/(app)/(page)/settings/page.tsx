import { redirect } from "next/navigation";

import { requireWorkspace } from "@/lib/workspace";

export default async function SettingsPage() {
  await requireWorkspace("/settings");
  redirect("/settings/team");
}
