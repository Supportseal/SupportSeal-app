import { redirect } from "next/navigation";

import { publicLegalLinks } from "@/config/legal";
import { isHostedMode } from "@/lib/hosting";
import { parsePlanIntent, planCheckoutPath, planOnboardingPath } from "@/lib/plan-intent";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams?: Promise<{ plan?: string | string[]; interval?: string | string[] }>;
} = {}) {
  // Choose Pro / Choose Business on the marketing pricing page link here
  // with the plan; it only means something where billing exists.
  const params = (await searchParams) ?? {};
  const planIntent = isHostedMode() ? parsePlanIntent(params.plan, params.interval) : null;
  // Sign-up CTAs on the marketing site link here unconditionally; a visitor
  // who is already signed in goes to the dashboard, as on /login, or
  // straight to checkout for the plan they picked.
  const user = await getSessionUser();
  if (user) {
    if (!planIntent) redirect("/inbox");
    // No Workspace yet (sign-up done, onboarding abandoned): checkout needs
    // one, so finish onboarding first and carry the pick along.
    const membership = await getPrimaryMembership(user.id);
    redirect(membership ? planCheckoutPath(planIntent) : planOnboardingPath(planIntent));
  }
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
  return <RegisterForm legalLinks={publicLegalLinks()} planIntent={planIntent} />;
}
