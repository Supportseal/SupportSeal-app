import { redirect } from "next/navigation";

import { publicLegalLinks } from "@/config/legal";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  // Sign-up CTAs on the marketing site link here unconditionally; a visitor
  // who is already signed in goes to the dashboard, as on /login.
  if (await getSessionUser()) redirect("/inbox");
  // Self-hosted first run (FR-HOST-01): once the single Workspace exists,
  // registration closes — additional users arrive by invitation.
  if (!isHostedMode()) {
    const workspaceCount = await prisma.workspace.count();
    if (workspaceCount > 0) {
      return (
        <div className="text-center">
          <h4 className="text-[1.375rem] font-medium text-heading">Registration is closed</h4>
          <p className="mt-2 text-sm text-muted">
            This SupportSeal installation already has a Workspace. Ask your administrator for an
            invitation.
          </p>
        </div>
      );
    }
    return <RegisterForm />;
  }
  return <RegisterForm legalLinks={publicLegalLinks()} />;
}
