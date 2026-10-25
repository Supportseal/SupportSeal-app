import { createHash, randomBytes } from "node:crypto";

import { redirect } from "next/navigation";

import { PLANS, planForWorkspace } from "@/config/pricing";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { getSessionUser, type SessionUser } from "@/lib/session";

export type MembershipRole = "ADMIN" | "AGENT";

export type WorkspaceContext = {
  user: SessionUser;
  workspace: { id: string; name: string; plan?: "FREE" | "PRO" };
  role: MembershipRole;
};

export const INVITE_EXPIRY_DAYS = 7;

/** Hosted agent cap from PLANS. Null means unlimited (self-hosted, or a plan with no cap). */
async function agentLimitForWorkspace(workspaceId: string): Promise<number | null> {
  if (!isHostedMode()) return null;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  });
  if (!workspace) return null;
  return planForWorkspace(workspace.plan).agents;
}

function planFullError(limit: number): string {
  const planName = limit === PLANS.free.agents ? PLANS.free.name : "current";
  const members = limit === 1 ? "member" : "members";
  return `The ${planName} plan includes ${limit} team ${members}. Upgrade to Pro for unlimited agents.`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** V1: one user account primarily belongs to one Workspace (ADR-0001). */
export async function getPrimaryMembership(userId: string) {
  return prisma.membership.findFirst({
    where: { userId },
    include: { workspace: true },
  });
}

export async function createWorkspace(input: {
  userId: string;
  name: string;
}): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    return { ok: false, error: "Workspace name must be between 2 and 80 characters." };
  }

  const existingMembership = await getPrimaryMembership(input.userId);
  if (existingMembership) {
    return {
      ok: false,
      error: "This account already belongs to a Workspace. One Workspace per account is supported.",
    };
  }

  if (!isHostedMode()) {
    // Serialize the check-then-create with a transaction-scoped advisory
    // lock so two concurrent first runs cannot both create a Workspace.
    const workspace = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('supportseal-workspace-create'))`;
      const workspaceCount = await tx.workspace.count();
      if (workspaceCount > 0) {
        return null;
      }
      const created = await tx.workspace.create({ data: { name } });
      await tx.membership.create({
        data: {
          userId: input.userId,
          workspaceId: created.id,
          role: "ADMIN",
        },
      });
      return created;
    });
    if (!workspace) {
      return {
        ok: false,
        error:
          "This self-hosted deployment already has a Workspace. " +
          "A self-hosted installation serves exactly one Workspace (ADR-0001).",
      };
    }
    return { ok: true, workspaceId: workspace.id };
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace.create({ data: { name } });
    await tx.membership.create({
      data: {
        userId: input.userId,
        workspaceId: created.id,
        role: "ADMIN",
      },
    });
    return created;
  });

  return { ok: true, workspaceId: workspace.id };
}

/** Resolve the caller's Workspace context or redirect into onboarding. */
export async function requireWorkspace(nextPath = "/inbox"): Promise<WorkspaceContext> {
  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  const membership = await getPrimaryMembership(user.id);
  if (!membership) {
    redirect("/onboarding");
  }
  return {
    user,
    workspace: {
      id: membership.workspaceId,
      name: membership.workspace.name,
      plan: membership.workspace.plan,
    },
    role: membership.role,
  };
}

export async function createInvite(input: {
  workspaceId: string;
  actorUserId: string;
  actorRole: MembershipRole;
  email: string;
  role: MembershipRole;
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (input.actorRole !== "ADMIN") {
    return { ok: false, error: "Only Workspace admins can invite users." };
  }
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // Members plus live pending invites, so stacked invites cannot pass the cap.
  const now = new Date();
  const agentLimit = await agentLimitForWorkspace(input.workspaceId);
  if (agentLimit !== null) {
    const [members, pendingInvites] = await Promise.all([
      prisma.membership.count({ where: { workspaceId: input.workspaceId } }),
      prisma.invite.count({
        where: { workspaceId: input.workspaceId, acceptedAt: null, expiresAt: { gt: now } },
      }),
    ]);
    if (members + pendingInvites >= agentLimit) {
      return { ok: false, error: planFullError(agentLimit) };
    }
  }

  const existingMember = await prisma.membership.findFirst({
    where: { workspaceId: input.workspaceId, user: { email } },
  });
  if (existingMember) {
    return { ok: false, error: "That person is already a member of this Workspace." };
  }

  const pending = await prisma.invite.findFirst({
    where: {
      workspaceId: input.workspaceId,
      email,
      acceptedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (pending) {
    return { ok: false, error: "An invite for that email is already pending. Revoke it first." };
  }

  const token = randomBytes(24).toString("base64url");
  await prisma.invite.create({
    data: {
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      // Store only the hash: a database leak must not expose usable invites.
      tokenHash: createHash("sha256").update(token).digest("hex"),
      invitedById: input.actorUserId,
      expiresAt: new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return { ok: true, token };
}

export type InviteStatus = "pending" | "accepted" | "expired";

export async function listInvites(workspaceId: string) {
  const invites = await prisma.invite.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return invites.map((invite) => ({
    ...invite,
    status: resolveInviteStatus(invite),
  }));
}

export function resolveInviteStatus(invite: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): InviteStatus {
  if (invite.acceptedAt) return "accepted";
  if (invite.expiresAt.getTime() < Date.now()) return "expired";
  return "pending";
}

export async function revokeInvite(input: {
  workspaceId: string;
  actorRole: MembershipRole;
  inviteId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.actorRole !== "ADMIN") {
    return { ok: false, error: "Only Workspace admins can revoke invites." };
  }
  const invite = await prisma.invite.findFirst({
    where: { id: input.inviteId, workspaceId: input.workspaceId },
  });
  if (!invite) {
    return { ok: false, error: "Invite not found." };
  }
  await prisma.invite.delete({ where: { id: invite.id } });
  return { ok: true };
}

export async function getInviteByToken(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    include: { workspace: true },
  });
  if (!invite) return null;
  return { ...invite, status: resolveInviteStatus(invite) };
}

export async function acceptInvite(input: {
  token: string;
  userId: string;
  email: string;
}): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const invite = await getInviteByToken(input.token);
  if (!invite || invite.status !== "pending") {
    return { ok: false, error: "This invite is no longer valid." };
  }
  if (invite.email !== normalizeEmail(input.email)) {
    return {
      ok: false,
      error: `This invite was sent to ${invite.email}. Sign in with that email address to accept it.`,
    };
  }
  const existingMembership = await getPrimaryMembership(input.userId);
  if (existingMembership) {
    if (existingMembership.workspaceId === invite.workspaceId) {
      return { ok: true, workspaceId: invite.workspaceId };
    }
    return {
      ok: false,
      error: "This account already belongs to a Workspace. One Workspace per account is supported.",
    };
  }

  // Re-check under a Workspace advisory lock so concurrent accepts cannot pass the cap.
  const agentLimit = await agentLimitForWorkspace(invite.workspaceId);

  try {
    const rejection = await prisma.$transaction(async (tx) => {
      if (agentLimit !== null) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"supportseal-agent-limit-" + invite.workspaceId}))`;
        const members = await tx.membership.count({ where: { workspaceId: invite.workspaceId } });
        if (members >= agentLimit) return planFullError(agentLimit);
      }
      await tx.membership.create({
        data: {
          userId: input.userId,
          workspaceId: invite.workspaceId,
          role: invite.role,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return null;
    });
    if (rejection) return { ok: false, error: rejection };
  } catch (error) {
    // One-membership-per-account is enforced at the database level; surface
    // it as a friendly error instead of a 500.
    if ((error as { code?: string }).code === "P2002") {
      return {
        ok: false,
        error: "This account already belongs to a Workspace. One Workspace per account is supported.",
      };
    }
    throw error;
  }

  return { ok: true, workspaceId: invite.workspaceId };
}

export async function listMembers(workspaceId: string) {
  return prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

/** Workspace-wide support availability (one Live/Away for all Products). */
export async function getAvailability(workspaceId: string): Promise<"LIVE" | "AWAY"> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { availability: true },
  });
  return workspace?.availability ?? "LIVE";
}

export async function setAvailability(input: {
  workspaceId: string;
  actorRole: MembershipRole;
  availability: "LIVE" | "AWAY";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.actorRole !== "ADMIN") {
    return { ok: false, error: "Only Workspace admins can change support availability." };
  }
  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: { availability: input.availability },
  });
  return { ok: true };
}
