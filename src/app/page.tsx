import { redirect } from "next/navigation";

import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * App root. Signed-in visitors continue to the dashboard (the same landing
 * as after sign-in); everyone else gets the sign-in page, except on a fresh
 * self-hosted installation, where the first visit creates the Workspace.
 * The public marketing site is a separate deployment.
 */
export default async function RootPage() {
  if (await getSessionUser()) redirect("/inbox");
  if (!isHostedMode() && (await prisma.workspace.count()) === 0) redirect("/register");
  redirect("/login");
}
