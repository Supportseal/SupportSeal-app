import { getMailDomainState } from "@/lib/email/mail-domain";
import type { WorkspaceContext } from "@/lib/workspace";
import { MailSetupPanel } from "./mail-setup-panel";

/** Server wrapper: loads the (Workspace-scoped) mail domain state for the panel. */
export async function MailSetup({ ctx, productId }: { ctx: WorkspaceContext; productId: string }) {
  const state = await getMailDomainState(ctx, productId);
  return (
    <MailSetupPanel
      productId={productId}
      isAdmin={ctx.role === "ADMIN"}
      domain={
        state && {
          name: state.domain,
          verifiedAt: state.verifiedAt?.toISOString() ?? null,
          lastCheckedAt: state.lastCheckedAt?.toISOString() ?? null,
          records: state.records,
        }
      }
    />
  );
}
