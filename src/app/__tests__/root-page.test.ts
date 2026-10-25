import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  workspaces: 0,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { workspace: { count: async () => state.workspaces } } }));

import RootPage from "@/app/page";

describe("app root /", () => {
  beforeEach(() => {
    state.user = null;
    state.workspaces = 1;
    vi.unstubAllEnvs();
  });

  it("presents sign-in to an anonymous visitor on the hosted dashboard", async () => {
    vi.stubEnv("HOSTED_MODE", "1");
    state.workspaces = 0;
    await expect(RootPage()).rejects.toThrow("redirect:/login");
  });

  it("sends a signed-in visitor to the dashboard (the post-sign-in landing)", async () => {
    vi.stubEnv("HOSTED_MODE", "1");
    state.user = { id: "u1" };
    await expect(RootPage()).rejects.toThrow("redirect:/inbox");
  });

  it("starts a fresh self-hosted installation at registration", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    state.workspaces = 0;
    await expect(RootPage()).rejects.toThrow("redirect:/register");
  });

  it("presents sign-in on a self-hosted installation that has its Workspace", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    await expect(RootPage()).rejects.toThrow("redirect:/login");
  });
});
