import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as postAuth } from "@/app/api/auth/[...all]/route";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";
import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createInvite, createWorkspace } from "@/lib/workspace";

/**
 * Issue #180: self-hosted closes PUBLIC registration once the Workspace
 * exists (FR-HOST-01) but must still admit invited teammates at
 * POST /api/auth/sign-up/email.
 *
 * Issue #184: the gate is keyed on the invite TOKEN, not the request-body
 * email — keying it on the email let anyone probe addresses (200 = pending
 * invite exists, 422 = none). Missing, expired and accepted tokens now
 * share one indistinguishable 422, and unauthenticated POSTs are
 * rate-limited per client IP. Hosted mode skips the gate entirely.
 */

let db: TestDb;
let workspaceId = "";

beforeAll(async () => {
  db = await startTestDb();
  process.env.HOSTED_MODE = "";
});

afterAll(async () => {
  await stopTestDb(db);
  process.env.HOSTED_MODE = "";
});

beforeEach(async () => {
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const admin = await createTestUser(db.prisma, { email: "admin@example.com" });
  const created = await createWorkspace({ userId: admin.id, name: "Acme" });
  if (!created.ok) throw new Error("seed workspace failed");
  workspaceId = created.workspaceId;
});

/**
 * The in-process rate limiter persists across tests in this file, so each
 * test signs up from its own client IP (the widget session route tests
 * use the same trick).
 */
function signUpRequest(email: string, opts?: { inviteToken?: string; ip?: string }) {
  return new NextRequest("http://localhost:3000/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({
      name: "Invitee",
      email,
      password: "correct-horse-battery",
      ...(opts?.inviteToken ? { inviteToken: opts.inviteToken } : {}),
    }),
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": opts?.ip ?? "127.0.0.1",
    },
  });
}

async function seedInvite(): Promise<{ token: string; email: string; id: string }> {
  const admin = await db.prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
  const email = `invitee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await createInvite({
    workspaceId,
    actorUserId: admin.id,
    actorRole: "ADMIN",
    email,
    role: "AGENT",
  });
  if (!created.ok) throw new Error("seed invite failed");
  const tokenHash = createHash("sha256").update(created.token).digest("hex");
  const invite = await db.prisma.invite.findUniqueOrThrow({ where: { tokenHash } });
  return { token: created.token, email, id: invite.id };
}

async function expiredInviteToken(): Promise<string> {
  const { token, id } = await seedInvite();
  await db.prisma.invite.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  return token;
}

async function acceptedInviteToken(): Promise<string> {
  const { token, id } = await seedInvite();
  await db.prisma.invite.update({ where: { id }, data: { acceptedAt: new Date() } });
  return token;
}

describe("self-hosted sign-up gate (POST /api/auth/sign-up/email)", () => {
  it("admits a pending invite token: account and session are created", async () => {
    const { token, email } = await seedInvite();

    const response = await postAuth(signUpRequest(email, { inviteToken: token, ip: "10.1.0.1" }));

    expect(response.status).toBe(200);
    const user = await db.prisma.user.findUnique({ where: { email } });
    expect(user?.name).toBe("Invitee");
    expect(await db.prisma.session.findFirst({ where: { userId: user!.id } })).not.toBeNull();
  });

  it("admits the token even for a mismatched email: the accept path binds the email", async () => {
    // The gate's secret is the invite token (bearer); who the invite was
    // sent to is enforced by acceptInvite, which rejects the mismatch and
    // leaves the invite pending for the invited address.
    const { token, id } = await seedInvite();

    const response = await postAuth(
      signUpRequest("other-address@example.com", { inviteToken: token, ip: "10.1.0.2" }),
    );

    expect(response.status).toBe(200);
    const invite = await db.prisma.invite.findUniqueOrThrow({ where: { id } });
    expect(invite.acceptedAt).toBeNull();
  });

  it("still rejects a sign-up without a token with 422 (FR-HOST-01)", async () => {
    const response = await postAuth(signUpRequest("stranger@example.com", { ip: "10.1.0.3" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "user-creation-disabled" });
    expect(await db.prisma.user.findUnique({ where: { email: "stranger@example.com" } })).toBeNull();
  });

  it("leaves no enumeration oracle: every probe returns an identical response (issue #184)", async () => {
    // Seed a PENDING invite, then probe like an attacker would. Whether or
    // not the email has a pending invite — and whether the token is
    // missing, unknown, expired or accepted — the status, code and message
    // must all be indistinguishable.
    const { email, id } = await seedInvite();
    const expiredToken = await expiredInviteToken();
    const acceptedToken = await acceptedInviteToken();

    const probes = [
      signUpRequest(email, { ip: "10.1.0.4" }), // invited email, no token
      signUpRequest("stranger@example.com", { ip: "10.1.0.4" }), // email without any invite
      signUpRequest("stranger@example.com", { inviteToken: "not-a-real-token", ip: "10.1.0.4" }),
      signUpRequest(email, { inviteToken: expiredToken, ip: "10.1.0.4" }),
      signUpRequest(email, { inviteToken: acceptedToken, ip: "10.1.0.4" }),
    ];

    const responses = await Promise.all(probes.map((request) => postAuth(request)));
    for (const response of responses) {
      expect(response.status).toBe(422);
    }
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies) {
      expect(body).toEqual(bodies[0]);
    }
    expect(bodies[0]).toEqual({
      code: "user-creation-disabled",
      message: "Registration is closed on this installation.",
    });
    expect(await db.prisma.invite.findUniqueOrThrow({ where: { id } })).toMatchObject({
      acceptedAt: null,
    });
  });

  it("rate-limits unauthenticated sign-up POSTs per client IP (issue #184)", async () => {
    const ip = "10.1.0.5";
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp; i++) {
      // Gate rejections still consume limiter budget: the request was
      // admitted by the limiter and answered by the gate.
      const response = await postAuth(signUpRequest(`probe-${i}@example.com`, { ip }));
      expect(response.status).toBe(422);
    }

    const throttled = await postAuth(signUpRequest("probe-more@example.com", { ip }));
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "rate_limited" });

    // The bucket is per IP: another client is not affected.
    const other = await postAuth(signUpRequest("probe-other@example.com", { ip: "10.1.0.6" }));
    expect(other.status).toBe(422);
  });

  it("keeps public registration open in hosted mode without an invite", async () => {
    process.env.HOSTED_MODE = "1";
    try {
      const response = await postAuth(signUpRequest("open-registration@example.com", { ip: "10.1.0.7" }));

      expect(response.status).toBe(200);
      expect(
        await db.prisma.user.findUnique({ where: { email: "open-registration@example.com" } }),
      ).not.toBeNull();
    } finally {
      process.env.HOSTED_MODE = "";
    }
  });
});
