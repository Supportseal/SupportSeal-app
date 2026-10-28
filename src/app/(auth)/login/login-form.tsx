"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { authClient } from "@/lib/auth-client";
import { brand } from "@/lib/brand";
import { GitHubButton, OrDivider } from "../github-button";
import { ACCOUNT_NOT_LINKED, githubErrorMessage } from "../github-errors";
import { safeNextPath } from "./next-path";

export function LoginForm({ githubEnabled = false }: { githubEnabled?: boolean }) {
  const searchParams = useSearchParams();
  const githubError = githubEnabled ? searchParams.get("error") : null;
  // GitHub found an existing, unlinked account with the same email: the
  // password sign-in below proves ownership, then links GitHub to it.
  const linkAfterSignIn = githubError === ACCOUNT_NOT_LINKED;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setError("Invalid email or password.");
      setPending(false);
      return;
    }
    const destination = safeNextPath(searchParams.get("next"), window.location.origin);
    if (linkAfterSignIn) {
      const nextParam = encodeURIComponent(destination);
      const linked = await authClient.linkSocial({
        provider: "github",
        callbackURL: destination,
        errorCallbackURL: `/login?github_link=failed&next=${nextParam}`,
      });
      if (!linked.error) return; // redirecting to GitHub
    }
    // Full document navigation, never router.push: auth pages render Links
    // to protected routes (the header logo → /inbox), and a logged-out
    // prefetch of a protected route stores the proxy's 307-to-/login in the
    // client router cache. A soft navigation to the same route then replays
    // the stale redirect and wedges the router (sign-in appears hung until a
    // manual refresh). A document navigation bypasses that cache and boots
    // the app with the fresh session cookie.
    window.location.assign(destination);
  }

  function signInWithGitHub() {
    const next = safeNextPath(searchParams.get("next"), window.location.origin);
    const params = new URLSearchParams();
    if (searchParams.get("next")) params.set("next", next);
    const query = params.toString();
    return authClient.signIn.social({
      provider: "github",
      callbackURL: next,
      errorCallbackURL: `/login${query ? `?${query}` : ""}`,
    });
  }

  return (
    <Card>
      <CardContent className="p-8">
        <div className="mb-6 lg:hidden">
          <Logo />
        </div>
        <h4 className="text-[1.375rem] font-medium text-heading">Welcome to {brand.name}</h4>
        <p className="mt-1 mb-6 text-muted">Sign in to your Workspace</p>
        {githubError ? (
          <p className="mb-4 text-sm text-danger" data-github-error={githubError}>
            {githubErrorMessage(githubError, "login")}
            {githubError === "signup_disabled" ? (
              <>
                {" "}
                <Link href="/register" className="text-primary underline underline-offset-2">
                  Create an account
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {githubEnabled && !linkAfterSignIn ? (
          <>
            <GitHubButton label="Sign in with GitHub" start={signInWithGitHub} />
            <OrDivider />
          </>
        ) : null}
        <form className="space-y-4" method="post" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-sm text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button className="w-full" type="submit" disabled={pending}>
            {pending ? "Signing in…" : linkAfterSignIn ? "Sign in and connect GitHub" : "Sign in"}
          </Button>
        </form>
        <p className="mt-6 text-center text-[0.9375rem]">
          New to {brand.name}?{" "}
          <Link href="/register" className="text-primary">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
