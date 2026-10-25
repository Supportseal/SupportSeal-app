import { redirect } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { listApiTokens } from "@/lib/api-tokens";
import { requireWorkspace } from "@/lib/workspace";
import { CreateTokenForm } from "./create-token-form";
import { TokensList } from "./tokens-list";

export const metadata = { title: "API tokens" };

export default async function ApiTokensPage() {
  const ctx = await requireWorkspace("/settings/api-tokens");
  if (ctx.role !== "ADMIN") redirect("/settings/team");
  const tokens = await listApiTokens(ctx.workspace.id);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-medium text-heading">API tokens</h2>
        <p className="mt-1 text-muted">
          Tokens let scripts and agents call the Workspace API without signing in. Each token
          acts for this whole Workspace, so keep it secret and revoke it when it is no longer
          needed.
        </p>
      </header>

      <section>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <h3 className="text-sm font-medium text-muted">Create a token</h3>
            <CreateTokenForm />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted">Tokens</h3>
        {tokens.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            No API tokens yet.
          </p>
        ) : (
          <TokensList tokens={tokens} />
        )}
      </section>
    </div>
  );
}
