"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/**
 * Request a password reset (#22, ADR-0002): better-auth's requestPasswordReset
 * generates a one-hour, single-use token and emails it via the system email
 * path. The response is intentionally identical for known and unknown
 * addresses, so the copy here never confirms whether an account exists.
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (result.error) {
      // better-auth rate-limits this endpoint (3 requests / minute per IP in
      // production); a 429 means "wait", not "wrong address".
      if (result.error.status === 429) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else {
        setError("Could not send the reset email. Check the address and try again.");
      }
      setPending(false);
      return;
    }
    setSent(true);
    setPending(false);
  }

  return (
    <Card>
      <CardContent className="p-8">
        <h4 className="text-[1.375rem] font-medium text-heading">Reset your password</h4>
        <p className="mt-1 mb-6 text-muted">
          Enter your email and we&apos;ll send you a reset link
        </p>
        {sent ? (
          <div className="space-y-4">
            <p className="text-body">
              If an account exists for that email, a reset link is on its way.
              The link expires in one hour.
            </p>
            <p className="text-sm text-muted">
              Didn&apos;t get it? Check your spam folder, or try again in a few
              minutes.
            </p>
            <Link
              href="/forgot-password"
              className="inline-block text-primary"
              onClick={(event) => {
                event.preventDefault();
                setSent(false);
              }}
            >
              Use a different email
            </Link>
          </div>
        ) : (
          <form className="space-y-4" method="post" onSubmit={handleSubmit}>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}
        <p className="mt-6 text-center text-[0.9375rem]">
          Remembered it?{" "}
          <Link href="/login" className="text-primary">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
