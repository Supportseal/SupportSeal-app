import Link from "next/link";
import { notFound } from "next/navigation";

import { MailSetup } from "@/app/mail-setup/mail-setup";
import { DomainAllowlistWarning } from "@/components/domain-allowlist-warning";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getProductForWorkspace, getDiagnosticsEnabler } from "@/lib/products";
import { countFailedReplies, lastInboundReceived } from "@/lib/email/delivery";
import { isOutboundEmailConfigured, managedSender } from "@/lib/email/outbound";
import {
  ESCALATION_MAX_MINUTES,
  ESCALATION_MIN_MINUTES,
} from "@/lib/escalation";
import { getInstallSignals } from "@/lib/install-signals";
import { countSnapshotsForProduct } from "@/lib/diagnostics/store";
import { isHostedMode } from "@/lib/hosting";
import { requireWorkspace } from "@/lib/workspace";
import { ArchiveForm } from "./archive-form";
import { DeveloperTab } from "./developer-tab";
import { DomainsCard } from "./domains-card";
import { EditProductForm } from "./edit-product-form";
import { EmailTab } from "./email-tab";
import { InstallationCard } from "./installation-card";
import { WidgetTab } from "./widget-tab";

export const metadata = { title: "Product settings" };

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const ctx = await requireWorkspace(`/settings/products/${id}`);
  const product = await getProductForWorkspace(ctx.workspace.id, id);
  if (!product) notFound();

  const activeTab =
    tab === "widget"
      ? "widget"
      : tab === "email"
        ? "email"
        : tab === "developer"
          ? "developer"
          : "general";
  const emailTab = activeTab === "email";
  const widgetTab = activeTab === "widget";
  const [diagnosticsEnabler, snapshotCount, lastReceived, failedReplies, installSignals] = await Promise.all([
    getDiagnosticsEnabler({ workspaceId: ctx.workspace.id, productId: product.id }),
    countSnapshotsForProduct(ctx.workspace.id, product.id),
    emailTab ? lastInboundReceived(ctx.workspace.id, product.id) : null,
    emailTab ? countFailedReplies(ctx.workspace.id, product.id) : 0,
    widgetTab ? getInstallSignals({ workspaceId: ctx.workspace.id, productId: product.id }) : null,
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <span
          className="inline-block size-4 rounded-full"
          style={{ backgroundColor: product.primaryColor }}
          aria-hidden
        />
        <h2 className="text-xl font-semibold text-heading">{product.name}</h2>
        {product.archivedAt ? (
          <Badge variant="light" color="secondary">
            Archived
          </Badge>
        ) : null}
        <Button asChild variant="text" color="secondary" size="sm" className="ml-auto">
          <Link href="/settings/products">All Products</Link>
        </Button>
      </header>

      <nav className="flex gap-1 border-b border-border" aria-label="Product settings">
        {[
          { id: "general", label: "General", href: `/settings/products/${product.id}` },
          {
            id: "widget",
            label: "Widget",
            href: `/settings/products/${product.id}?tab=widget`,
          },
          {
            id: "email",
            label: "Email",
            href: `/settings/products/${product.id}?tab=email`,
          },
          {
            id: "developer",
            label: "Developer",
            href: `/settings/products/${product.id}?tab=developer`,
          },
        ].map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={activeTab === item.id ? "page" : undefined}
            className={
              activeTab === item.id
                ? "-mb-px border-b-2 border-primary px-4 py-2.5 text-sm font-medium text-heading"
                : "-mb-px border-b-2 border-transparent px-4 py-2.5 text-sm text-body hover:text-heading"
            }
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {activeTab === "general" ? (
        ctx.role === "ADMIN" ? (
          <div className="space-y-6">
            <EditProductForm
              product={{ id: product.id, name: product.name, primaryColor: product.primaryColor }}
            />
            <DomainsCard
              productId={product.id}
              domains={product.domains.map((d) => ({ id: d.id, domain: d.domain }))}
            />
            <ArchiveForm productId={product.id} archived={product.archivedAt !== null} />
          </div>
        ) : (
          <p className="text-sm text-muted">Only Workspace admins can edit Product settings.</p>
        )
      ) : activeTab === "email" ? (
        <EmailTab
          product={{
            id: product.id,
            name: product.name,
            inboundEmail: product.inboundEmail,
            supportEmail: product.supportEmail,
            archived: product.archivedAt !== null,
            isAdmin: ctx.role === "ADMIN",
          }}
          managedSender={managedSender()}
          lastReceived={lastReceived}
          failedReplies={failedReplies}
          mailSetup={<MailSetup ctx={ctx} productId={product.id} />}
          escalation={{
            productId: product.id,
            enabled: product.escalationEnabled,
            afterMinutes: product.escalationAfterMinutes,
            minMinutes: ESCALATION_MIN_MINUTES,
            maxMinutes: ESCALATION_MAX_MINUTES,
            mailConfigured: isOutboundEmailConfigured(),
            isAdmin: ctx.role === "ADMIN",
          }}
        />
      ) : activeTab === "widget" ? (
        <div className="space-y-6">
          {product.archivedAt === null ? (
            <DomainAllowlistWarning
              productId={product.id}
              domains={product.domains.map((d) => d.domain)}
            />
          ) : null}
          <WidgetTab
            product={{
              id: product.id,
              name: product.name,
              primaryColor: product.primaryColor,
              widgetPublicKey: product.widgetPublicKey,
              archived: product.archivedAt !== null,
            }}
          />
          {installSignals ? (
            <InstallationCard
              productId={product.id}
              isAdmin={ctx.role === "ADMIN"}
              now={new Date().toISOString()}
              loaded={installSignals.loaded.map((r) => ({ host: r.host, lastSeenAt: r.lastSeenAt.toISOString() }))}
              rejected={installSignals.rejected.map((r) => ({
                host: r.host,
                lastSeenAt: r.lastSeenAt.toISOString(),
                sibling: r.sibling,
              }))}
            />
          ) : null}
        </div>
      ) : (
        <DeveloperTab
          product={{
            id: product.id,
            name: product.name,
            widgetPublicKey: product.widgetPublicKey,
            formPublicKey: product.formPublicKey,
            archived: product.archivedAt !== null,
            isAdmin: ctx.role === "ADMIN",
            diagnosticsEnabled: product.diagnosticsEnabledAt !== null,
            diagnosticsEnabledBy: diagnosticsEnabler,
            snapshotCount,
            hosted: isHostedMode(),
          }}
        />
      )}
    </div>
  );
}
