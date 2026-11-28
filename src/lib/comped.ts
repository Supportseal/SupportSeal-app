import { isHostedMode } from "@/lib/hosting";

/**
 * Comped Workspaces (hosted only): the operator's own or staff Workspaces
 * that stay on Pro without a paying subscription. Listed by Workspace id in
 * HOSTED_COMPED_PRO_WORKSPACE_IDS (comma-separated). Billing sync never
 * writes a comped Workspace below Pro, so a refund, a dispute or a canceled
 * subscription leaves it on Pro; a paid Business plan still wins.
 * Self-hosted ignores the list (there is no billing to override).
 *
 * Limits: the comp is stored as an ordinary `plan = PRO`. Removing a
 * Workspace from the list reverts it on the next sync only when it has a
 * Stripe customer; one without a customer stays Pro until its row is set
 * back by hand. A comped Workspace also cannot start a Business checkout
 * (it already counts as subscribed).
 */
export function isCompedWorkspace(workspaceId: string): boolean {
  if (!isHostedMode()) return false;
  const raw = process.env.HOSTED_COMPED_PRO_WORKSPACE_IDS ?? "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(workspaceId);
}
