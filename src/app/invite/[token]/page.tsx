import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getInviteByToken } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";
import { AcceptInviteForm } from "./accept-invite-form";
import { InviteSignUpForm } from "./sign-up-invite-form";

export const metadata = { title: "Workspace invite" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInviteByToken(token);
  const user = await getSessionUser();

  if (!invite || invite.status !== "pending") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-body-bg p-6">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <h1 className="text-[1.375rem] font-medium text-heading">Invite not available</h1>
            <p className="text-muted">
              This invite link is invalid, expired, or already used. Ask a Workspace admin for a
              fresh invite.
            </p>
            <Button asChild variant="outline">
              <Link href="/login">Go to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const emailMatches = user !== null && user.email.toLowerCase() === invite.email;

  return (
    <main className="flex min-h-screen items-center justify-center bg-body-bg p-6">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 space-y-4">
          <div className="space-y-1">
            <Badge>{invite.workspace.name}</Badge>
            <h1 className="text-[1.375rem] font-medium text-heading">
              Join {invite.workspace.name}
            </h1>
            <p className="text-muted">
              You have been invited as <strong>{invite.role === "ADMIN" ? "an Admin" : "an Agent"}</strong>{" "}
              for <strong>{invite.email}</strong>.
            </p>
          </div>
          {user === null ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Create an account for <strong>{invite.email}</strong> to join this Workspace.
              </p>
              <InviteSignUpForm token={token} email={invite.email} />
              <p className="text-center text-[0.9375rem]">
                Already have an account?{" "}
                <Link
                  href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
                  className="text-primary"
                >
                  Sign in
                </Link>
              </p>
            </div>
          ) : emailMatches ? (
            <AcceptInviteForm token={token} />
          ) : (
            <p className="text-sm text-danger">
              You are signed in as {user.email}, but this invite was sent to {invite.email}. Sign
              in with that address to accept it.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
