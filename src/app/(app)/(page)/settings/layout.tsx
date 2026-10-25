import { isHostedMode } from "@/lib/hosting";

import { SettingsNav } from "./settings-nav";
import { requireWorkspace } from "@/lib/workspace";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireWorkspace("/settings");

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-semibold text-heading">Settings</h1>
      <SettingsNav hosted={isHostedMode()} isAdmin={ctx.role === "ADMIN"} />
      {children}
    </div>
  );
}
