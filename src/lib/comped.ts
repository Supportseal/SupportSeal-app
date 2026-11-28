import { isHostedMode } from "@/lib/hosting";

/**
 * Comped Workspaces (hosted only): the operator's own or staff Workspaces
 * that stay on Pro without a paying subscription. Listed by Workspace id in
 * HOSTED_COMPED_PRO_WORKSPACE_IDS (comma-separated). Billing sync never
 * writes a comped Workspace below Pro, so a refund, a dispute or a canceled
 * subscription leaves it on Pro; a paid Business plan still wins.
 * Self-hosted ignores the list (there is no billing to override).
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
