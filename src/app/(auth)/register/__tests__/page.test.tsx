import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";

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

import RegisterPage from "../page";

async function render() {
  return renderToStaticMarkup(await RegisterPage());
}

/**
 * FR-HOST-01 guard: /register stays closed on a self-hosted installation
 * once its Workspace exists — invited teammates sign up through the invite
 * link instead (issue #180), never through plain /register.
 */
describe("register page", () => {
  beforeEach(() => {
    state.user = null;
    state.workspaces = 0;
    vi.unstubAllEnvs();
  });

  it("opens registration on a fresh self-hosted installation", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    const markup = await render();
    expect(markup).toContain("Create your account");
    expect(markup).toContain("Sign up");
  });

  it("stays closed once the Workspace exists (no invite bypass on /register)", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    state.workspaces = 1;
    const markup = await render();
    expect(markup).toContain("Registration is closed");
    expect(markup).not.toContain("Sign up");
  });

  it("shows the form in hosted mode even with existing Workspaces", async () => {
    vi.stubEnv("HOSTED_MODE", "1");
    state.workspaces = 3;
    const markup = await render();
    expect(markup).toContain("Create your account");
  });

  it("shows the plan picked on the pricing page in hosted mode", async () => {
    vi.stubEnv("HOSTED_MODE", "1");
    const markup = renderToStaticMarkup(
      await RegisterPage({ searchParams: Promise.resolve({ plan: "pro", interval: "year" }) }),
    );
    expect(markup).toContain("You picked Pro (annual).");
  });

  it("ignores a plan on a self-hosted installation, which has no billing", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    const markup = renderToStaticMarkup(
      await RegisterPage({ searchParams: Promise.resolve({ plan: "pro" }) }),
    );
    expect(markup).toContain("Create your account");
    expect(markup).not.toContain("data-plan-intent");
  });

  it("sends a signed-in visitor who picked a plan to checkout", async () => {
    vi.stubEnv("HOSTED_MODE", "1");
    state.user = { id: "u1" };
    await expect(
      RegisterPage({ searchParams: Promise.resolve({ plan: "business" }) }),
    ).rejects.toThrow("redirect:/settings/billing?plan=business&interval=month");
  });

  it("sends a signed-in visitor to the dashboard", async () => {
    vi.stubEnv("HOSTED_MODE", "");
    state.user = { id: "u1" };
    state.workspaces = 0;
    await expect(RegisterPage()).rejects.toThrow("redirect:/inbox");
  });
});
