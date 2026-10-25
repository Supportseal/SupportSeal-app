"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { acceptInviteAction } from "./actions";
import { inviteSignUpPayload, runInviteSignUp } from "./sign-up-flow";

/**
 * Sign-up embedded in the accept-invite page (docs/design/onboarding.md,
 * "Invited teammate"): name and password only — the email is fixed by the
 * invite and read-only. Self-hosted keeps public registration closed
 * (FR-HOST-01); the sign-up API admits this request because it carries a
 * pending invite TOKEN (issue #184), not because of the email.
 */
export function InviteSignUpForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set once better-auth created the account (and its session). A failed
  // accept must never re-run sign-up on retry — the account exists now.
  const [accountCreated, setAccountCreated] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    try {
      const outcome = await runInviteSignUp(accountCreated, {
        signUpEmail: () =>
          authClient.signUp.email(inviteSignUpPayload({ name, email, password, token })),
        acceptInvite: () => acceptInviteAction(token),
        // Record the account the instant it exists, before accept runs:
        // an accept that throws (network drop, 500) must behave like one
        // returning {error} — a retry re-runs accept only, never sign-up.
        onAccountCreated: () => setAccountCreated(true),
      });
      if (outcome.kind === "sign-up-failed") {
        setError(outcome.message);
      } else if (outcome.kind === "accept-failed") {
        setError(outcome.message);
        // The account and session already exist: re-render the page as
        // signed-in (AcceptInviteForm, or the mismatch / not-available
        // view) so any retry goes through accept, never sign-up again.
        router.refresh();
      }
      // Success: acceptInviteAction redirects to /inbox (same pattern as
      // AcceptInviteForm); the redirect keeps the navigation running and
      // pending stays up while it does.
    } catch {
      setError("Something went wrong while joining. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" method="post" onSubmit={handleSubmit}>
      <div>
        <Label htmlFor="invite-name">Name</Label>
        <Input id="invite-name" name="name" autoComplete="name" required maxLength={80} />
      </div>
      <div>
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          defaultValue={email}
          readOnly
          autoComplete="email"
        />
        <p className="mt-1 text-xs text-muted">This invitation was sent to that address.</p>
      </div>
      <div>
        <Label htmlFor="invite-password">Password</Label>
        <Input
          id="invite-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={pending}>
        {pending
          ? accountCreated
            ? "Joining…"
            : "Creating account…"
          : accountCreated
            ? "Join workspace"
            : "Create account and join"}
      </Button>
    </form>
  );
}
