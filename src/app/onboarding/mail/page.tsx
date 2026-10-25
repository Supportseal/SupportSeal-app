import Link from "next/link";
import { redirect } from "next/navigation";

import { MailSetup } from "@/app/mail-setup/mail-setup";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { siteConfig } from "@/config/site";
import { getMailDomainState } from "@/lib/email/mail-domain";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/workspace";
import { WizardShell } from "../wizard-shell";
import { saveSupportEmailAction } from "../actions";

export const metadata = { title: "Get started · Mail" };

export default async function MailStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const ctx = await requireWorkspace("/onboarding/mail");
  const product = await prisma.product.findFirst({
    where: { workspaceId: ctx.workspace.id },
    select: { id: true, inboundEmail: true, supportEmail: true },
    orderBy: { createdAt: "asc" },
  });
  if (!product) redirect("/onboarding/product");
  const verified = (await getMailDomainState(ctx, product.id))?.status === "verified";

  return (
    <WizardShell step={4} heading="Receive support email">
      <div className="space-y-6">
        <Alert color="info" title="Your support address is ready — no DNS needed">
          Customers can already email{" "}
          {product.inboundEmail ? <code>{product.inboundEmail}</code> : "your Product's generated address"}.
          {" "}This included address needs no DNS changes from you. Custom-domain setup is optional
          and does not affect when your chat widget works. Find this address again in Settings →
          Products → your Product → Email.
        </Alert>
        <Card>
          <CardContent className="space-y-3 p-6">
            <form action={saveSupportEmailAction} className="space-y-2">
              <label htmlFor="supportEmail" className="text-sm font-medium text-heading">
                Your support address <span className="font-normal text-muted">(optional)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="supportEmail"
                  name="supportEmail"
                  type="email"
                  defaultValue={product.supportEmail ?? ""}
                  placeholder="support@acme.com"
                  maxLength={254}
                  className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-heading"
                />
                <Button type="submit" color="secondary" variant="outline">Save</Button>
              </div>
              <p className="text-xs text-muted">
                The address customers write to. The chat widget can show it, and {siteConfig.name}{" "}
                never sends mail to it, so forwarding it here cannot create a loop.
              </p>
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              {saved ? <p className="text-sm text-success">Saved.</p> : null}
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 p-6">
            <h3 className="text-sm font-medium text-heading">Optional: use your own mail domain</h3>
            <p className="text-sm text-body">
              Enter a dedicated mail domain below and choose Show DNS records. Then add the
              displayed records at your DNS provider and choose Verify records. {siteConfig.name}
              {" "}checks DNS before marking the custom domain verified. DNS changes may appear
              within minutes, but cached records can take longer, depending on your provider and
              their time to live (TTL). You can continue while you wait.
            </p>
            <MailSetup ctx={ctx} productId={product.id} />
          </CardContent>
        </Card>
        <div className="flex items-center gap-3">
          <Button asChild color={verified ? "primary" : "secondary"} variant={verified ? "solid" : "outline"}>
            <Link href="/onboarding/install">{verified ? "Continue" : "Skip for now"}</Link>
          </Button>
          {verified ? null : (
            <span className="text-xs text-muted">Finish custom-domain setup later in Product settings → Email.</span>
          )}
        </div>
      </div>
    </WizardShell>
  );
}
