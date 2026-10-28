import Link from "next/link";
import { redirect } from "next/navigation";

import { requireWorkspace } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { TrackOnMount } from "@/components/analytics/track-on-mount";
import { WizardShell } from "../wizard-shell";
import { DomainStepForm } from "./domain-step-form";

export const metadata = { title: "Get started · Domain" };

export default async function DomainStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const ctx = await requireWorkspace("/onboarding/domain");
  const product = await prisma.product.findFirst({
    where: { workspaceId: ctx.workspace.id },
    include: { domains: true },
    orderBy: { createdAt: "asc" },
  });
  if (!product) redirect("/onboarding/product");

  return (
    <WizardShell step={3} heading="Where will the widget run?">
      <DomainStepForm
        existingDomains={product.domains.map((d) => d.domain)}
        error={error === "invalid" ? "Enter a hostname like app.example.com." : error}
        productId={product.id}
      />
      {error ? <TrackOnMount event="onboarding_error" data={{ step: "domain" }} /> : null}
      <p className="mt-4 text-xs text-muted">
        Tip: you can also manage domains any time in{" "}
        <Link href={`/settings/products/${product.id}`} className="text-primary hover:underline">
          Product settings
        </Link>
        .
      </p>
    </WizardShell>
  );
}
