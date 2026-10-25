import { redirect } from "next/navigation";

import { computeChecklist } from "@/lib/onboarding";
import { requireWorkspace } from "@/lib/workspace";
import { SetupChecklistView } from "./setup-checklist";

export const metadata = { title: "Setup checklist" };

export default async function SetupChecklistPage() {
  const ctx = await requireWorkspace("/settings/setup");
  if (ctx.role !== "ADMIN") redirect("/settings/team");
  const checklist = await computeChecklist(ctx.workspace.id);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium text-heading">Setup checklist</h2>
        <p className="mt-1 text-muted">
          What is left to get your Workspace fully set up. Progress is read from your real data,
          so it stays current across devices and teammates.
        </p>
      </header>
      <SetupChecklistView checklist={checklist} />
    </div>
  );
}
