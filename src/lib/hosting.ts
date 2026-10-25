/**
 * Hosting mode. V1 ships self-hosted by default: the deployment serves
 * exactly one Workspace (ADR-0001) and never requires Stripe or external
 * services. Setting HOSTED_MODE=1 enables the multi-Workspace SaaS modules
 * (usage metering + Stripe billing).
 */
export function isHostedMode(): boolean {
  return process.env.HOSTED_MODE === "1";
}

export const routing = {
  home: "/inbox",
  login: "/login",
  register: "/register",
  onboarding: "/onboarding",
} as const;
