import { authorizeAdminApi } from "@/lib/admin-api";
import { apiError, guardApi } from "@/lib/api-errors";
import { parsePatchBody, productFailure, productResponse } from "@/lib/product-api";
import { getProductForWorkspace, patchProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Workspace admin API (issue #170): one Product by id. A Product in another
 * Workspace answers 404, never its key (FR-SEC-01).
 */
export function GET(request: Request, { params }: RouteContext) {
  return guardApi(async () => {
    const auth = await authorizeAdminApi(request, "products:read");
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const product = await getProductForWorkspace(auth.ctx.workspaceId, id);
    if (!product) return apiError("not_found", "Product not found.");
    return productResponse(product);
  });
}

/**
 * Edit a Product in the token's own Workspace (issue #187): name, colour, support
 * email and domains (`addDomains` / `removeDomains`), applied all-or-nothing. Token-only.
 * Another Workspace's id answers 404 exactly like an unknown id.
 */
export function PATCH(request: Request, { params }: RouteContext) {
  return guardApi(async () => {
    const auth = await authorizeAdminApi(request, "products:write");
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const parsed = await parsePatchBody(request);
    if (!parsed.ok) return parsed.response;

    const result = await patchProduct({
      ctx: { workspace: { id: auth.ctx.workspaceId }, role: "ADMIN" },
      productId: id,
      ...parsed.body,
    });
    if (!result.ok) return productFailure(result);
    return productResponse(result.product);
  });
}
