import { createHash } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { rateLimitAuthSignUp } from "@/lib/auth-rate-limit";
import { getAuth } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";

async function handle(request: NextRequest) {
  // Self-hosted first run (FR-HOST-01): once the single Workspace exists,
  // public sign-up is closed at the API level, not just in the UI — new
  // users arrive by invitation. Hosted mode skips this gate entirely.
  if (
    !isHostedMode() &&
    request.method === "POST" &&
    request.nextUrl.pathname.endsWith("/sign-up/email")
  ) {
    // Charged before any database access: the gate answers unauthenticated
    // probes, so the bucket keys on the client IP alone (issue #184).
    if (!rateLimitAuthSignUp(request)) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    const workspaceCount = await prisma.workspace.count();
    if (workspaceCount > 0) {
      // Invited teammates can still create an account: self-hosted closes
      // PUBLIC registration, not invite acceptance. The gate is keyed on
      // the invite TOKEN (issue #184), not the request-body email: keying
      // it on the email let anyone probe addresses (200 = pending invite
      // exists, 422 = none). The token travels as an extra body field the
      // accept-invite sign-up form already holds; better-auth ignores
      // unknown sign-up fields, and the accept path re-validates both
      // token and email anyway.
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { inviteToken?: string } | null;
      const token = body?.inviteToken?.trim();
      // Same lookup as the accept path (getInviteByToken): findUnique on
      // the hashed token. Missing, expired and accepted invites share ONE
      // response, so the endpoint leaks nothing about who was invited.
      const invite = token
        ? await prisma.invite.findUnique({
            where: { tokenHash: createHash("sha256").update(token).digest("hex") },
            select: { acceptedAt: true, expiresAt: true },
          })
        : null;
      const pending =
        invite !== null &&
        invite.acceptedAt === null &&
        invite.expiresAt.getTime() > Date.now();
      if (!pending) {
        return NextResponse.json(
          { code: "user-creation-disabled", message: "Registration is closed on this installation." },
          { status: 422 },
        );
      }
    }
  }
  const auth = await getAuth();
  return auth.handler(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
