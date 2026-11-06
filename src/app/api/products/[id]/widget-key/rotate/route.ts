import { authorizeAdminApi } from "@/lib/admin-api";
import { guardApi } from "@/lib/api-errors";
import { productFailure, productResponse } from "@/lib/product-api";
import { rotateProductWidgetKey } from "@/lib/products";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Rotate a Product's public widget key (issue #19; dashboard counterpart:
 * Widget tab "Rotate widget key"). Immediate, no grace period: the previous
 * key stops working on every widget route at once. Token-only, like every
 * write; another Workspace's id answers 404 exactly like an unknown id.
 */
export function POST(request: Request, { params }: RouteContext) {
  return guardApi(async () => {
    const auth = await authorizeAdminApi(request, "products:write");
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const ctx = { workspace: { id: auth.ctx.workspaceId }, role: "ADMIN" as const };
    const rotated = await rotateProductWidgetKey({ ctx, productId: id });
    if (!rotated.ok) return productFailure(rotated);
    return productResponse(rotated.product);
  });
}
