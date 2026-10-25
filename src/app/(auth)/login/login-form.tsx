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
import { safeNextPath } from "./next-path";

export function LoginForm() {
  const searchParams = useSearchParams();
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
    // Full document navigation, never router.push: auth pages render Links
    // to protected routes (the header logo → /inbox), and a logged-out
    // prefetch of a protected route stores the proxy's 307-to-/login in the
    // client router cache. A soft navigation to the same route then replays
    // the stale redirect and wedges the router (sign-in appears hung until a
    // manual refresh). A document navigation bypasses that cache and boots
    // the app with the fresh session cookie.
    window.location.assign(safeNextPath(searchParams.get("next"), window.location.origin));
  }

  return (
    <Card>
      <CardContent className="p-8">
        <div className="mb-6 lg:hidden">
          <Logo />
        </div>
        <h4 className="text-[1.375rem] font-medium text-heading">Welcome to {brand.name}</h4>
        <p className="mt-1 mb-6 text-muted">Sign in to your Workspace</p>
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
            {pending ? "Signing in…" : "Sign in"}
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
