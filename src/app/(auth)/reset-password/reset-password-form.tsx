"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * Complete a password reset (#22, ADR-0002). better-auth's callback route
 * redirects here as /reset-password?token=… on success or
 * ?error=INVALID_TOKEN for an expired/used/unknown token; completing the
 * form revokes existing sessions (revokeSessionsOnPasswordReset). On
 * success the consumed token is replaced with ?reset=complete so it does
 * not linger in the address bar or history.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const complete = searchParams.get("reset") === "complete";
  const invalid =
    searchParams.get("error") === "INVALID_TOKEN" || (!token && !complete);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const newPassword = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (newPassword !== confirm) {
      setError("The passwords do not match.");
      setPending(false);
      return;
    }
    const result = await authClient.resetPassword({ newPassword, token });
    if (result.error) {
      setError(
        result.error.code === "INVALID_TOKEN"
          ? "This reset link is no longer valid. Request a new one."
          : "Could not reset the password. Check the details and try again.",
      );
      setPending(false);
      return;
    }
    setDone(true);
    setPending(false);
    router.replace("/reset-password?reset=complete");
  }

  if (invalid) {
    return (
      <Card>
        <CardContent className="p-8">
          <h4 className="text-[1.375rem] font-medium text-heading">Reset link expired</h4>
          <p className="mt-2 mb-6 text-body">
            This password reset link is invalid, already used or older than one
            hour. Request a fresh link to continue.
          </p>
          <Button asChild className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
          <p className="mt-6 text-center text-[0.9375rem]">
            <Link href="/login" className="text-primary">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-8">
        <h4 className="text-[1.375rem] font-medium text-heading">Choose a new password</h4>
        <p className="mt-1 mb-6 text-muted">
          For your security, every signed-in session is signed out when the
          password changes.
        </p>
        {done || complete ? (
          <div className="space-y-4">
            <p className="text-body">Your password has been updated.</p>
            <Button asChild className="w-full">
              <Link href="/login">Continue to sign in</Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" method="post" onSubmit={handleSubmit}>
            <div>
              <Label htmlFor="password">New password</Label>
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
            <div>
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Set new password"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
