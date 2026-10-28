import { redirect } from "next/navigation";

import { listProducts } from "@/lib/products";
import { resolveWizardState } from "@/lib/onboarding";
import { isHostedMode } from "@/lib/hosting";
import { parsePlanIntent } from "@/lib/plan-intent";
import { getSessionUser } from "@/lib/session";
import { createWorkspace, getPrimaryMembership } from "@/lib/workspace";
import { Logo } from "@/components/layout/logo";
import { WizardShell } from "./wizard-shell";
import { createWorkspaceAction } from "./actions";

export const metadata = { title: "Get started" };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ fresh?: string; plan?: string; interval?: string }>;
}) {
  const { fresh, plan, interval } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login?next=%2Fonboarding");

  const membership = await getPrimaryMembership(user.id);
  if (!membership) {
    // A plan picked on the pricing page by someone already signed in rides
    // along as hidden fields; the sign-up form's cookie covers new accounts.
    const planIntent = isHostedMode() ? parsePlanIntent(plan, interval) : null;
    // Step 1: create the Workspace (also the self-hosted first run).
    return (
      <main className="min-h-screen bg-body-bg">
        <WizardShell step={1} heading="Create your Workspace">
          <form action={createWorkspaceAction} className="space-y-4">
            {planIntent ? (
              <>
                <input type="hidden" name="plan" value={planIntent.plan} />
                <input type="hidden" name="interval" value={planIntent.interval} />
              </>
            ) : null}
            <div>
              <label htmlFor="name" className="text-sm font-medium text-heading">
                Workspace name
              </label>
              <input
                id="name"
                name="name"
                defaultValue={`${user.name.split(" ")[0]}'s Workspace`}
                required
                minLength={2}
                maxLength={80}
                className="mt-1.5 h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-heading"
              />
              <p className="mt-1 text-xs text-muted">Your team and all your Products live here.</p>
            </div>
            <WizardShell.Submit label="Continue" />
          </form>
        </WizardShell>
      </main>
    );
  }

  const products = await listProducts(membership.workspaceId);
  const product = products[0] ?? null;
  void createWorkspace;
  const state = resolveWizardState(
    { user, workspace: membership.workspace, role: membership.role },
    product ? { id: product.id, name: product.name, primaryColor: product.primaryColor, widgetPublicKey: product.widgetPublicKey } : null,
    (product?.domains.length ?? 0) > 0,
  );

  if (state.step <= 2) {
    redirect("/onboarding/product");
  }
  if (state.step === 3) {
    redirect("/onboarding/domain");
  }
  redirect(`/onboarding/install${fresh ? "?fresh=1" : ""}`);
}

export { Logo };
