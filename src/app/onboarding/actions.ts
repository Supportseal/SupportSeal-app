"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { addProductDomain, createProduct, normalizeDomain, setProductSupportEmail } from "@/lib/products";
import { createWorkspace as createWorkspaceService, requireWorkspace } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { isHostedMode } from "@/lib/hosting";
import {
  deserializePlanIntent,
  parsePlanIntent,
  PLAN_INTENT_COOKIE,
  planCheckoutPath,
  planOnboardingPath,
} from "@/lib/plan-intent";

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=%2Fonboarding");
  const name = String(formData.get("name") ?? "");
  const result = await createWorkspaceService({ userId: user.id, name });
  // Hidden fields come from a plan picked just now; the sign-up cookie may be
  // older, so the fields win and the error redirect keeps them.
  const picked = parsePlanIntent(formData.get("plan"), formData.get("interval"));
  if (!result.ok) {
    redirect(picked ? `${planOnboardingPath(picked)}&error=1` : "/onboarding?error=1");
  }
  revalidatePath("/", "layout");
  // A visitor who picked a paid plan on the pricing page goes to checkout
  // now that the Workspace exists; the billing page links back to setup.
  const cookieStore = await cookies();
  const intent = picked ?? deserializePlanIntent(cookieStore.get(PLAN_INTENT_COOKIE)?.value);
  cookieStore.delete(PLAN_INTENT_COOKIE);
  if (intent && isHostedMode()) redirect(planCheckoutPath(intent));
  redirect("/onboarding/product");
}

export async function createProductAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/onboarding");
  const name = String(formData.get("name") ?? "");
  const color = String(formData.get("primaryColor") ?? "#2563eb");
  const result = await createProduct({ ctx, name, primaryColor: color });
  if (!result.ok) redirect(`/onboarding/product?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/", "layout");
  redirect("/onboarding/domain");
}

export async function saveDomainsAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/onboarding");
  const product = await prisma.product.findFirst({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "asc" },
  });
  if (!product) redirect("/onboarding/product");

  const raw = String(formData.get("domains") ?? "");
  const allowLocalhost = String(formData.get("allowLocalhost") ?? "") === "on";
  const entries = raw
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  let added = 0;
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!domain) continue;
    const result = await addProductDomain({ ctx, productId: product.id, domain });
    if (result.ok) added += 1;
  }
  if (allowLocalhost) {
    const result = await addProductDomain({ ctx, productId: product.id, domain: "localhost" });
    if (result.ok) added += 1;
  }
  revalidatePath("/", "layout");
  if (added === 0 && entries.length > 0) {
    redirect(`/onboarding/domain?error=invalid`);
  }
  redirect("/onboarding/mail");
}

export async function skipDomainsAction(): Promise<void> {
  redirect("/onboarding/mail");
}

/** Optional wizard field: the address customers write to (display + loop guard only). */
export async function saveSupportEmailAction(formData: FormData): Promise<void> {
  const ctx = await requireWorkspace("/onboarding");
  const product = await prisma.product.findFirst({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!product) redirect("/onboarding/product");
  const result = await setProductSupportEmail({
    ctx,
    productId: product.id,
    supportEmail: String(formData.get("supportEmail") ?? ""),
  });
  if (!result.ok) redirect(`/onboarding/mail?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/", "layout");
  redirect("/onboarding/mail?saved=1");
}
