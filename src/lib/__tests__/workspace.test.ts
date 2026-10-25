import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { PLANS } from "@/config/pricing";
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  getInviteByToken,
  getPrimaryMembership,
  listMembers,
  revokeInvite,
} from "@/lib/workspace";

let db: TestDb;

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
});

describe("createWorkspace", () => {
  it("creates a workspace with an ADMIN membership", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    const result = await createWorkspace({ userId: user.id, name: "Acme Studio" });
    expect(result.ok).toBe(true);

    const membership = await getPrimaryMembership(user.id);
    expect(membership?.workspace.name).toBe("Acme Studio");
    expect(membership?.role).toBe("ADMIN");
  });

  it("rejects invalid names", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    expect((await createWorkspace({ userId: user.id, name: "a" })).ok).toBe(false);
    expect((await createWorkspace({ userId: user.id, name: "   " })).ok).toBe(false);
  });

  it("blocks a second workspace for the same account (V1 one-workspace rule)", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    await createWorkspace({ userId: user.id, name: "First" });
    const second = await createWorkspace({ userId: user.id, name: "Second" });
    expect(second).toEqual({
      ok: false,
      error: expect.stringContaining("already belongs to a Workspace"),
    });
  });

  it("blocks a second workspace on a self-hosted deployment (enforced single Workspace)", async () => {
    const first = await createTestUser(db.prisma, { email: "a@example.com" });
    const second = await createTestUser(db.prisma, { email: "b@example.com" });
    await createWorkspace({ userId: first.id, name: "Alpha" });
    const result = await createWorkspace({ userId: second.id, name: "Beta" });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("exactly one Workspace"),
    });
  });

  it("allows multiple workspaces when HOSTED_MODE=1", async () => {
    process.env.HOSTED_MODE = "1";
    try {
      const first = await createTestUser(db.prisma, { email: "a@example.com" });
      const second = await createTestUser(db.prisma, { email: "b@example.com" });
      expect((await createWorkspace({ userId: first.id, name: "Alpha" })).ok).toBe(true);
      expect((await createWorkspace({ userId: second.id, name: "Beta" })).ok).toBe(true);
    } finally {
      process.env.HOSTED_MODE = "";
    }
  });
});

describe("invites", () => {
  async function seedWorkspace() {
    const admin = await createTestUser(db.prisma, { email: "admin@example.com" });
    const agent = await createTestUser(db.prisma, { email: "agent@example.com" });
    const created = await createWorkspace({ userId: admin.id, name: "Acme" });
    if (!created.ok) throw new Error("seed workspace failed");
    const workspaceId = created.workspaceId;
    await db.prisma.membership.create({
      data: { userId: agent.id, workspaceId, role: "AGENT" },
    });
    return { admin, agent, workspaceId };
  }

  it("creates, accepts and lists invites; non-admins cannot invite", async () => {
    const { admin, agent, workspaceId } = await seedWorkspace();

    const forbidden = await createInvite({
      workspaceId,
      actorUserId: agent.id,
      actorRole: "AGENT",
      email: "new@example.com",
      role: "AGENT",
    });
    expect(forbidden.ok).toBe(false);

    const created = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "New@Example.com",
      role: "AGENT",
    });
    expect(created.ok).toBe(true);

    const duplicate = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "new@example.com",
      role: "AGENT",
    });
    expect(duplicate.ok).toBe(false);

    const newbie = await createTestUser(db.prisma, { email: "someone.else@example.com" });
    const wrongEmail = await acceptInvite({
      token: (created as { ok: true; token: string }).token,
      userId: newbie.id,
      email: newbie.email,
    });
    expect(wrongEmail.ok).toBe(false);

    const invitedUser = await createTestUser(db.prisma, { email: "new@example.com" });
    const plainToken = (created as { ok: true; token: string }).token;
    const accepted = await acceptInvite({
      token: plainToken,
      userId: invitedUser.id,
      email: invitedUser.email,
    });
    expect(accepted.ok).toBe(true);

    // Tokens are stored hashed: the plain form must not appear in the table.
    const row = await db.prisma.invite.findFirstOrThrow({ where: { email: "new@example.com" } });
    expect(row.tokenHash).toBeTruthy();
    expect(row.tokenHash).not.toBe(plainToken);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex

    const members = await listMembers(workspaceId);
    expect(members.map((m) => m.user.email)).toEqual(
      expect.arrayContaining(["admin@example.com", "agent@example.com", "new@example.com"]),
    );
    expect(members.find((m) => m.user.email === "new@example.com")?.role).toBe("AGENT");

    const inviteAfter = await getInviteByToken((created as { ok: true; token: string }).token);
    expect(inviteAfter?.status).toBe("accepted");
  });

  it("rejects expired invites and supports revocation", async () => {
    const { admin, workspaceId } = await seedWorkspace();
    const created = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "late@example.com",
      role: "AGENT",
    });
    expect(created.ok).toBe(true);
    const token = (created as { ok: true; token: string }).token;

    await db.prisma.invite.update({
      where: { tokenHash: (await import("node:crypto")).createHash("sha256").update(token).digest("hex") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await getInviteByToken(token);
    expect(expired?.status).toBe("expired");

    const fresh = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "fresh@example.com",
      role: "AGENT",
    });
    expect(fresh.ok).toBe(true);

    const inviteRow = await db.prisma.invite.findFirstOrThrow({
      where: { email: "fresh@example.com" },
    });
    const revoked = await revokeInvite({ workspaceId, actorRole: "ADMIN", inviteId: inviteRow.id });
    expect(revoked.ok).toBe(true);
    expect(
      await db.prisma.invite.findFirst({ where: { email: "fresh@example.com" } }),
    ).toBeNull();
  });
});

describe("plan agent limits (hosted, issue #15: Free 1 agent, Pro unlimited)", () => {
  async function seedHostedWorkspace(plan: "FREE" | "PRO") {
    const admin = await createTestUser(db.prisma, { email: "founder@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Acme", plan, memberships: { create: { userId: admin.id, role: "ADMIN" } } },
    });
    return { admin, workspaceId: workspace.id };
  }

  beforeEach(() => {
    process.env.HOSTED_MODE = "1";
  });

  afterEach(() => {
    process.env.HOSTED_MODE = "";
  });

  it("blocks invites beyond the Free plan's single member", async () => {
    const { admin, workspaceId } = await seedHostedWorkspace("FREE");
    const blocked = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "teammate@example.com",
      role: "AGENT",
    });
    expect(blocked).toEqual({
      ok: false,
      error: expect.stringContaining("Upgrade to Pro for unlimited agents"),
    });
  });

  it("counts live pending invites against the limit", async () => {
    const originalAgents = PLANS.free.agents;
    PLANS.free.agents = 2;
    try {
      const { admin, workspaceId } = await seedHostedWorkspace("FREE");
      const first = await createInvite({
        workspaceId,
        actorUserId: admin.id,
        actorRole: "ADMIN",
        email: "first@example.com",
        role: "AGENT",
      });
      expect(first.ok).toBe(true); // 1 member + 1 pending < 2

      const second = await createInvite({
        workspaceId,
        actorUserId: admin.id,
        actorRole: "ADMIN",
        email: "second@example.com",
        role: "AGENT",
      });
      expect(second).toEqual({
        ok: false,
        error: expect.stringContaining("includes 2 team members"),
      });
    } finally {
      PLANS.free.agents = originalAgents;
    }
  });

  it("allows invites on Pro (unlimited agents)", async () => {
    const { admin, workspaceId } = await seedHostedWorkspace("PRO");
    const allowed = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "teammate@example.com",
      role: "AGENT",
    });
    expect(allowed.ok).toBe(true);
  });

  it("re-checks the limit when an invite is accepted", async () => {
    const { admin, workspaceId } = await seedHostedWorkspace("FREE");
    // Bypass createInvite: a pre-limit invite lingering after the cap hit.
    const token = "legacy-invite-token";
    await db.prisma.invite.create({
      data: {
        workspaceId,
        email: "legacy@example.com",
        role: "AGENT",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        invitedById: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const legacy = await createTestUser(db.prisma, { email: "legacy@example.com" });
    const accepted = await acceptInvite({ token, userId: legacy.id, email: legacy.email });
    expect(accepted).toEqual({
      ok: false,
      error: expect.stringContaining("Upgrade to Pro for unlimited agents"),
    });
  });

  it("self-hosted mode never limits agents (no hosted plans)", async () => {
    process.env.HOSTED_MODE = "";
    const { admin, workspaceId } = await seedHostedWorkspace("FREE");
    const teammate = await createTestUser(db.prisma, { email: "teammate@example.com" });
    await db.prisma.membership.create({
      data: { userId: teammate.id, workspaceId, role: "AGENT" },
    });
    const allowed = await createInvite({
      workspaceId,
      actorUserId: admin.id,
      actorRole: "ADMIN",
      email: "another@example.com",
      role: "AGENT",
    });
    expect(allowed.ok).toBe(true);
  });
});
