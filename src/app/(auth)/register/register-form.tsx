"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMAIL_TAKEN_CODE } from "@/app/invite/[token]/sign-up-flow";
import { refFromSearch, track } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import {
  PLAN_INTENT_COOKIE,
  PLAN_INTENT_MAX_AGE_SECONDS,
  serializePlanIntent,
  type PlanIntent,
} from "@/lib/plan-intent";
import type { SocialProvider } from "@/lib/social-auth";
import { OrDivider, SocialButton } from "../social-button";
import { ACCOUNT_NOT_LINKED, SOCIAL_PROVIDER_NAMES, socialErrorMessage } from "../social-errors";

type LegalLink = { slug: string; label: string; href: string };

function LegalLinkTo({ links, slug }: { links: LegalLink[]; slug: string }) {
  const link = links.find((candidate) => candidate.slug === slug);
  if (!link) throw new Error(`Signup legal notice is missing the ${slug} document.`);
  return (
    <a href={link.href} className="text-primary underline underline-offset-2">
      {link.label}
    </a>
  );
}

/** Rendered only when the hosted legal pages are operative (issue #14). */
function SignupLegalNotice({ links }: { links: LegalLink[] }) {
  if (links.length === 0) return null;
  return (
    <p className="text-xs text-muted" data-signup-legal-notice="">
      By creating an account, you agree to the <LegalLinkTo links={links} slug="terms" /> and{" "}
      <LegalLinkTo links={links} slug="acceptable-use" />, and acknowledge the{" "}
      <LegalLinkTo links={links} slug="privacy" />.
    </p>
  );
}

const PLAN_LABELS: Record<PlanIntent["plan"], string> = { pro: "Pro", business: "Business" };

function rememberPlanIntent(planIntent: PlanIntent | null) {
  if (!planIntent) return;
  // Picked up when the Workspace is created, which then opens checkout.
  document.cookie = `${PLAN_INTENT_COOKIE}=${serializePlanIntent(planIntent)}; Path=/; Max-Age=${PLAN_INTENT_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function RegisterForm({
  legalLinks = [],
  planIntent = null,
  providers = [],
  socialError = null,
}: {
  legalLinks?: LegalLink[];
  planIntent?: PlanIntent | null;
  providers?: SocialProvider[];
  socialError?: { code: string; provider: SocialProvider } | null;
}) {
  const socialEnabled = providers.length > 0;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(false);
  const plan = planIntent?.plan ?? "none";

  // Sign-up funnel (docs/analytics.md): a page view alone can be a bot or a
  // link preview; typing in the form or clicking a provider is a person.
  function funnelData() {
    return { plan, ref: refFromSearch(window.location.search) };
  }

  function handleFirstInput() {
    if (started) return;
    setStarted(true);
    track("signup_form_started", funnelData());
  }

  function signUpWith(provider: SocialProvider) {
    track("signup_social_clicked", { ...funnelData(), method: provider });
    rememberPlanIntent(planIntent);
    // Back to /register: it sends a signed-in visitor on to checkout (or
    // onboarding) for the picked plan, and to /inbox otherwise.
    const params = new URLSearchParams();
    if (planIntent) {
      params.set("plan", planIntent.plan);
      params.set("interval", planIntent.interval);
    }
    const here = `/register${params.size ? `?${params.toString()}` : ""}`;
    params.set("provider", provider);
    return authClient.signIn.social({
      provider,
      requestSignUp: true,
      callbackURL: here,
      newUserCallbackURL: "/onboarding",
      errorCallbackURL: `/register?${params.toString()}`,
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    track("signup_submitted", { ...funnelData(), method: "email" });
    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) {
      // The old kebab-case "user-already-exists" check never matched, so a
      // returning visitor saw the generic error instead of "Sign in".
      const exists = result.error.code === EMAIL_TAKEN_CODE;
      track("signup_failed", { method: "email", reason: exists ? "exists" : "other" });
      setError(
        exists
          ? "An account with that email already exists. Sign in instead."
          : "Could not create the account. Check the details and try again.",
      );
      setPending(false);
      return;
    }
    track("signup_completed", { ...funnelData(), method: "email" });
    rememberPlanIntent(planIntent);
    // Full document navigation for the same reason as the login form: auth
    // pages prefetch protected routes (logo → /inbox), and a soft navigation
    // to /onboarding can replay a stale logged-out redirect from the client
    // router cache. See login-form.tsx.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional: post-auth navigation must boot a fresh document with the new session cookie
    window.location.assign("/onboarding");
  }

  return (
    <Card>
      <CardContent className="p-8">
        <h4 className="text-[1.375rem] font-medium text-heading">Create your account</h4>
        <p className="mt-1 mb-6 text-muted">
          One account, one Workspace, every product you build
        </p>
        {planIntent ? (
          <p className="-mt-3 mb-6 rounded-md bg-primary-label px-3 py-2 text-sm text-heading" data-plan-intent="">
            You picked {PLAN_LABELS[planIntent.plan]} ({planIntent.interval === "year" ? "annual" : "monthly"}).
            Create your account and Workspace, then finish checkout.
          </p>
        ) : null}
        {socialError ? (
          <p className="mb-4 text-sm text-danger" data-social-error={socialError.code}>
            {socialErrorMessage(socialError.code, "register", socialError.provider)}
            {socialError.code === ACCOUNT_NOT_LINKED ? (
              <>
                {" "}
                <Link
                  href={`/login?error=${ACCOUNT_NOT_LINKED}&provider=${socialError.provider}`}
                  className="text-primary underline underline-offset-2"
                >
                  Sign in
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {socialEnabled ? (
          <>
            <div className="space-y-3">
              {providers.map((provider) => (
                <SocialButton
                  key={provider}
                  provider={provider}
                  label={`Sign up with ${SOCIAL_PROVIDER_NAMES[provider]}`}
                  start={() => signUpWith(provider)}
                />
              ))}
            </div>
            <OrDivider />
          </>
        ) : null}
        <form className="space-y-4" method="post" onSubmit={handleSubmit} onInput={handleFirstInput}>
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required maxLength={80} />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {socialEnabled ? null : <SignupLegalNotice links={legalLinks} />}
          <Button className="w-full" type="submit" disabled={pending}>
            {pending ? "Creating account…" : "Sign up"}
          </Button>
        </form>
        {/* With several ways to sign up, the notice sits under all of them
            so it plainly covers the provider buttons too. */}
        {socialEnabled ? (
          <div className="mt-4">
            <SignupLegalNotice links={legalLinks} />
          </div>
        ) : null}
        <p className="mt-6 text-center text-[0.9375rem]">
          Already have an account?{" "}
          <Link href="/login" className="text-primary">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
