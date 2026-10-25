import { redirect } from "next/navigation";

import { requireWorkspace } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { WizardShell } from "../wizard-shell";
import { ProductStepForm } from "./product-step-form";

export const metadata = { title: "Get started · Product" };

export default async function ProductStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const ctx = await requireWorkspace("/onboarding/product");
  const existing = await prisma.product.findFirst({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "asc" },
  });
  if (existing) redirect("/onboarding/domain");

  return (
    <WizardShell step={2} heading="Add your first Product">
      <ProductStepForm error={error} />
    </WizardShell>
  );
}
