import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getInviteByToken: vi.fn() }));

import InvitePage from "../page";
import { getSessionUser } from "@/lib/session";
import { getInviteByToken } from "@/lib/workspace";

type Invite = Awaited<ReturnType<typeof getInviteByToken>>;

function pendingInvite(): NonNullable<Invite> {
  return {
    id: "invite-1",
    workspaceId: "workspace-1",
    workspace: {
      id: "workspace-1",
      name: "Acme",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      plan: "FREE",
      freePlanPausedAt: null,
      stripeCustomerId: null,
      stripeCheckoutSessionId: null,
      stripeSubscriptionId: null,
      availability: "LIVE",
      nextTicketNumber: 1,
    },
    email: "teammate@example.com",
    role: "AGENT",
    tokenHash: "hash",
    invitedById: "admin-1",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    status: "pending",
  };
}

async function render(token: string) {
  return renderToStaticMarkup(await InvitePage({ params: Promise.resolve({ token }) }));
}

describe("accept-invite page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(null);
  });

  it("offers embedded sign-up for a signed-out visitor with a pending invite (#180)", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(pendingInvite());

    const markup = await render("tok");

    expect(markup).toContain("Create an account for <strong>teammate@example.com</strong>");
    expect(markup).toContain("Create account and join");
    expect(markup).toContain('value="teammate@example.com"');
    expect(markup).toContain('readOnly=""');
    expect(markup).not.toContain('href="/register"');
    expect(markup).toContain('href="/login?next=%2Finvite%2Ftok"');
  });

  it("rejects an unknown token", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(null);

    expect(await render("unknown")).toContain("Invite not available");
  });

  it("rejects an expired invite", async () => {
    const invite = pendingInvite();
    invite.status = "expired";
    invite.expiresAt = new Date(Date.now() - 60_000);
    vi.mocked(getInviteByToken).mockResolvedValue(invite);

    expect(await render("tok")).toContain("Invite not available");
  });

  it("rejects a consumed invite", async () => {
    const invite = pendingInvite();
    invite.status = "accepted";
    invite.acceptedAt = new Date();
    vi.mocked(getInviteByToken).mockResolvedValue(invite);

    expect(await render("tok")).toContain("Invite not available");
  });

  it("asks a signed-in matching user to accept, not to sign up", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(pendingInvite());
    vi.mocked(getSessionUser).mockResolvedValue({
      id: "user-1",
      name: "Teammate",
      email: "teammate@example.com",
    });

    const markup = await render("tok");

    expect(markup).toContain("Accept invite");
    expect(markup).not.toContain("Create account and join");
  });

  it("explains an email mismatch to a signed-in user", async () => {
    vi.mocked(getInviteByToken).mockResolvedValue(pendingInvite());
    vi.mocked(getSessionUser).mockResolvedValue({
      id: "user-2",
      name: "Someone Else",
      email: "other@example.com",
    });

    expect(await render("tok")).toContain("this invite was sent to teammate@example.com");
  });
});
